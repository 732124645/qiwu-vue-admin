package io.qiwu.livekit

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.twilio.audioswitch.AudioDevice
import com.twilio.audioswitch.AudioDeviceChangeListener
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.participant.Participant
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoTrack
import io.livekit.android.util.LoggingLevel
import java.lang.ref.WeakReference
import java.net.URI
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.FutureTask
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

internal data class QwNativeParticipant(
    val identity: String, val name: String, val local: Boolean,
    val microphone: Boolean, val camera: Boolean,
)

internal data class QwNativeSnapshot(
    val connectionId: String, val state: String, val localIdentity: String,
    val microphone: Boolean, val camera: Boolean, val speakerPreferred: Boolean,
    val participants: List<QwNativeParticipant>,
) {
    /** 固定字段用系统 JSON 编码，姓名等内容不会拼接成脚本。 */
    fun json(): JSONObject = JSONObject().put("connectionId", connectionId).put("state", state)
        .put("localIdentity", localIdentity).put("microphone", microphone).put("camera", camera)
        .put("speakerPreferred", speakerPreferred).put("participants", JSONArray().apply {
            participants.forEach { person -> put(JSONObject().put("identity", person.identity).put("name", person.name)
                .put("local", person.local).put("microphone", person.microphone).put("camera", person.camera)) }
        })
}

internal data class QwNativeFailure(val code: String, val operation: String)
internal data class QwNativeEvent(val type: String, val snapshot: QwNativeSnapshot, val error: QwNativeFailure? = null) {
    /** 无错误时也保留 null 字段，与公开桥面类型一致。 */
    fun json(): String = JSONObject().put("type", type).put("snapshot", snapshot.json())
        .put("error", error?.let { JSONObject().put("code", it.code).put("operation", it.operation) } ?: JSONObject.NULL).toString()
}
internal enum class QwRoomEvent { CONNECTED, RECONNECTING, DISCONNECTED, PARTICIPANTS, TRACKS, AUDIO_ROUTE }

/** 测试仅替换原生 SDK 端口；Room、Track 和协程不会穿过脚本桥。 */
internal interface QwRoomPort {
    var eventHandler: ((QwRoomEvent) -> Unit)?
    val localIdentity: String
    val microphone: Boolean
    val camera: Boolean
    val speakerPreferred: Boolean
    val participants: List<QwNativeParticipant>
    suspend fun connect(url: String, token: String)
    suspend fun setMicrophone(enabled: Boolean)
    suspend fun setCamera(enabled: Boolean)
    suspend fun switchCamera()
    suspend fun setSpeaker(preferred: Boolean)
    fun retire()
    suspend fun disconnect()
    fun bind(view: FrameLayout, participantId: String)
    fun unbind(view: FrameLayout)
}

/** 取消与完成共用一次终局；先放下闭包，防止脚本重入产生二次通知。 */
private class QwNativeOperation(
    val name: String,
    private var success: ((QwNativeSnapshot) -> Unit)?,
    private var failure: ((QwNativeFailure) -> Unit)?,
) {
    var job: Job? = null
    fun finish(snapshot: QwNativeSnapshot) {
        val callback = success; success = null; failure = null
        callback?.let { runCatching { it(snapshot) } }
    }
    fun fail(code: String) {
        val callback = failure; success = null; failure = null
        callback?.let { runCatching { it(QwNativeFailure(code, name)) } }
    }
}

private data class QwVideoBinding(val connectionId: String, val participantId: String, val room: WeakReference<QwRoomPort>)

/** 单一 Room 协调器在主线程串行化状态，连接编号和代次同时隔离迟到 SDK 回调。 */
internal class QwNativeCoordinator(private val scope: CoroutineScope, private val makeRoom: () -> QwRoomPort) {
    private var room: QwRoomPort? = null
    private var generation = 0L
    private var connectionId = ""
    private var state = "idle"
    private var closing = false
    private var pending: QwNativeOperation? = null
    private var listener: ((QwNativeEvent) -> Unit)? = null
    private val views = WeakHashMap<FrameLayout, QwVideoBinding>()
    val snapshot: QwNativeSnapshot
        get() {
            checkMain()
            return QwNativeSnapshot(connectionId, state, room?.localIdentity ?: "", room?.microphone ?: false,
                room?.camera ?: false, room?.speakerPreferred ?: false, room?.participants ?: emptyList())
        }
    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())
    private fun current(candidate: QwRoomPort, at: Long) = room === candidate && generation == at && state != "idle" && state != "disconnecting"

    /** 外部停止监听不影响原生内部观察和资源释放。 */
    fun observe(callback: ((QwNativeEvent) -> Unit)?) { checkMain(); listener = callback }
    private fun emit(type: String, error: QwNativeFailure? = null) {
        val event = QwNativeEvent(type, snapshot, error)
        listener?.let { runCatching { it(event) } }
    }
    private fun installEvents(candidate: QwRoomPort, at: Long) {
        candidate.eventHandler = event@{ event ->
            checkMain()
            if (!current(candidate, at)) return@event
            when (event) {
                QwRoomEvent.CONNECTED -> if (state == "reconnecting") { state = "connected"; refreshViews(); emit("state") }
                QwRoomEvent.RECONNECTING -> if (state == "connected") { state = "reconnecting"; emit("state") }
                QwRoomEvent.DISCONNECTED -> close(candidate, "DISCONNECTED", null, null)
                QwRoomEvent.PARTICIPANTS -> { refreshViews(); emit("participants") }
                QwRoomEvent.TRACKS -> { refreshViews(); emit("tracks") }
                QwRoomEvent.AUDIO_ROUTE -> emit("audio-route")
            }
        }
    }

    /** 凭据只交官方 SDK，入口拒绝明文远端、URL 用户信息和无界输入。 */
    fun connect(url: String, token: String, microphone: Boolean, camera: Boolean,
                success: (QwNativeSnapshot) -> Unit, failure: (QwNativeFailure) -> Unit) {
        checkMain()
        if (room != null || state != "idle") { failure(QwNativeFailure("BUSY", "connect")); return }
        val address = runCatching { URI(url) }.getOrNull()
        val host = address?.host?.removeSurrounding("[", "]")
        if (address == null || host.isNullOrEmpty() || address.rawUserInfo != null || address.rawFragment != null ||
            !(address.scheme == "wss" || (address.scheme == "ws" && host in listOf("localhost", "127.0.0.1", "::1"))) ||
            url.toByteArray(Charsets.UTF_8).size > 2048) { failure(QwNativeFailure("INVALID_URL", "connect")); return }
        if (token.isEmpty() || token.toByteArray(Charsets.UTF_8).size > 16384 || token.any { Character.isISOControl(it) }) {
            failure(QwNativeFailure("INVALID_TOKEN", "connect")); return
        }
        val candidate = try { makeRoom() } catch (_: Exception) { failure(QwNativeFailure("SDK_ERROR", "connect")); return }
        val at = ++generation
        connectionId = UUID.randomUUID().toString(); room = candidate; state = "connecting"
        val operation = QwNativeOperation("connect", success, failure)
        pending = operation
        installEvents(candidate, at); emit("state")
        operation.job = scope.launch(start = CoroutineStart.LAZY) {
            if (!current(candidate, at) || !isActive) return@launch
            try {
                candidate.connect(url, token)
                if (!current(candidate, at) || !isActive) { releaseLate(candidate); return@launch }
                if (microphone) {
                    candidate.setMicrophone(true)
                    if (!current(candidate, at) || !isActive) { releaseLate(candidate); return@launch }
                }
                if (camera) {
                    candidate.setCamera(true)
                    if (!current(candidate, at) || !isActive) { releaseLate(candidate); return@launch }
                }
                pending = null; state = "connected"
                val result = snapshot
                // 画面失败事件可能重入并创建新连接，完成结果必须先固定为本次连接。
                refreshViews()
                operation.finish(result)
                if (current(candidate, at)) emit("state")
            } catch (_: Exception) {
                if (current(candidate, at)) close(candidate, "SDK_ERROR", null, null) else releaseLate(candidate)
            }
        }
        operation.job?.start()
    }

    /** 旧连接的停止请求不能结束后来建立的 Room。 */
    fun disconnect(id: String, success: (QwNativeSnapshot) -> Unit, failure: (QwNativeFailure) -> Unit) {
        checkMain()
        if (id.isEmpty() || id != connectionId) { failure(QwNativeFailure("STALE_CONNECTION", "disconnect")); return }
        if (closing) { failure(QwNativeFailure("BUSY", "disconnect")); return }
        val candidate = room
        if (candidate == null) { success(snapshot); return }
        close(candidate, "CANCELLED", success, failure)
    }

    /** 先退役并取消操作，再清采集与视图；清理结束前不接受新的 Room。 */
    private fun close(candidate: QwRoomPort, code: String, completion: ((QwNativeSnapshot) -> Unit)?, failure: ((QwNativeFailure) -> Unit)?) {
        val at = ++generation
        state = "disconnecting"; closing = true
        var preparationFailed = false
        fun prepareRelease(action: () -> Unit) { try { action() } catch (_: Exception) { preparationFailed = true } }
        prepareRelease { candidate.eventHandler = null }; prepareRelease { candidate.retire() }
        val operation = pending; pending = null
        operation?.job?.cancel(); operation?.fail(code)
        // SDK 解绑失败仍交给整体清理重试，不能中断后面的采集停止与释放。
        views.keys.toList().forEach { view -> prepareRelease { candidate.unbind(view) } }
        emit("state")
        if (code != "CANCELLED") emit("error", QwNativeFailure(code, operation?.name ?: "connection"))
        scope.launch {
            val released = releaseLate(candidate, notify = false) && !preparationFailed
            if (room !== candidate || generation != at) return@launch
            closing = false
            if (!released) {
                val error = QwNativeFailure("SDK_ERROR", "disconnect")
                emit("error", error)
                failure?.let { runCatching { it(error) } }
                return@launch
            }
            room = null; state = "idle"
            val result = snapshot
            emit("state"); completion?.let { runCatching { it(result) } }
        }
    }
    /** 清理失败不逃到全局协程处理器；旧 Room 的错误不能污染后来连接。 */
    private suspend fun releaseLate(candidate: QwRoomPort, notify: Boolean = true): Boolean = withContext(NonCancellable) {
        try { candidate.disconnect(); true }
        catch (_: Exception) {
            if (notify && room === candidate) emit("error", QwNativeFailure("SDK_ERROR", "disconnect"))
            false
        }
    }

    /** 媒体操作串行执行，迟到的启用不能覆盖已退休连接或后来关闭。 */
    fun action(id: String, name: String, enabled: Boolean,
               success: (QwNativeSnapshot) -> Unit, failure: (QwNativeFailure) -> Unit) {
        checkMain()
        val candidate = room
        if (id != connectionId || candidate == null) { failure(QwNativeFailure("STALE_CONNECTION", name)); return }
        if (state != "connected") { failure(QwNativeFailure("NOT_CONNECTED", name)); return }
        if (pending != null) { failure(QwNativeFailure("BUSY", name)); return }
        if (name == "switchCamera" && !candidate.camera) { failure(QwNativeFailure("NO_CAMERA", name)); return }
        val at = generation
        val operation = QwNativeOperation(name, success, failure)
        pending = operation
        operation.job = scope.launch(start = CoroutineStart.LAZY) {
            if (!current(candidate, at) || !isActive) return@launch
            try {
                when (name) {
                    "setMicrophoneEnabled" -> candidate.setMicrophone(enabled)
                    "setCameraEnabled" -> candidate.setCamera(enabled)
                    "switchCamera" -> candidate.switchCamera()
                    "setSpeakerOutputPreferred" -> candidate.setSpeaker(enabled)
                    else -> throw IllegalArgumentException()
                }
                if (!current(candidate, at) || !isActive) { releaseLate(candidate); return@launch }
                pending = null
                val result = snapshot
                refreshViews()
                operation.finish(result)
                if (current(candidate, at)) emit(if (name == "setSpeakerOutputPreferred") "audio-route" else "tracks")
            } catch (_: Exception) {
                if (!current(candidate, at)) { releaseLate(candidate); return@launch }
                pending = null; operation.fail("SDK_ERROR")
                if (current(candidate, at)) emit("error", QwNativeFailure("SDK_ERROR", name))
            }
        }
        operation.job?.start()
    }

    /** connecting 先登记意图，接通时自动兑现，不要求组件重新发送同一 props。 */
    fun bind(view: FrameLayout, id: String, participantId: String) {
        checkMain()
        if (!unbind(view)) return
        val candidate = room ?: return
        if (id != connectionId || state !in listOf("connecting", "connected", "reconnecting")) return
        views[view] = QwVideoBinding(id, participantId, WeakReference(candidate))
        if (state != "connecting") {
            try { candidate.bind(view, participantId) }
            catch (_: Exception) { emit("error", QwNativeFailure("SDK_ERROR", "bindVideoView")) }
        }
    }
    /** 解绑失败保留旧意图并阻止新 identity，不能把未释放画面当成空容器。 */
    fun unbind(view: FrameLayout): Boolean {
        checkMain()
        val binding = views[view] ?: return true
        return try {
            binding.room.get()?.unbind(view)
            views.remove(view)
            true
        } catch (_: Exception) {
            emit("error", QwNativeFailure("SDK_ERROR", "unbindVideoView"))
            false
        }
    }
    private fun refreshViews() {
        val candidate = room ?: return
        if (state !in listOf("connected", "reconnecting")) return
        views.toMap().forEach { (view, binding) ->
            if (binding.connectionId == connectionId && binding.room.get() === candidate) {
                try { candidate.bind(view, binding.participantId) }
                catch (_: Exception) { emit("error", QwNativeFailure("SDK_ERROR", "bindVideoView")) }
            }
        }
    }
}

internal typealias QwPermissionRequest = (Boolean, (Boolean) -> Unit) -> Unit
internal typealias QwResourceStop = () -> Unit
private class QwCleanupFailure : IllegalStateException("Native media cleanup failed")

/** 只替换视频资源端口，测试仍使用真正的 Android View 和同一条释放记录链。 */
internal interface QwVideoResource {
    val view: View
    fun initialize()
    fun bind(participantId: String)
    fun unbind()
    fun release()
}

private class QwSDKVideoResource(context: Context, private val room: Room) : QwVideoResource {
    override val view = TextureViewRenderer(context)
    private var track: WeakReference<VideoTrack>? = null
    override fun initialize() { room.initVideoRenderer(view) }
    override fun bind(participantId: String) {
        val person: Participant? = if (participantId == room.localParticipant.identity?.value) room.localParticipant
            else room.remoteParticipants.values.firstOrNull { it.identity?.value == participantId }
        val next = person?.getTrackPublication(Track.Source.CAMERA)?.track as? VideoTrack
        val previous = track?.get()
        if (previous !== next) {
            previous?.removeRenderer(view)
            track = next?.let { WeakReference(it) }
            next?.addRenderer(view)
        }
    }
    override fun unbind() { track?.get()?.removeRenderer(view); track = null }
    override fun release() { view.release() }
}

/** 系统授权可能重复回调，取消后只能丢弃结果，不能恢复已退休的采集操作。 */
internal suspend fun awaitQwPermission(camera: Boolean, request: QwPermissionRequest) {
    suspendCancellableCoroutine<Unit> { continuation ->
        val replied = AtomicBoolean(false)
        request(camera) { granted ->
            if (replied.compareAndSet(false, true) && continuation.isActive) {
                if (granted) continuation.resume(Unit) else continuation.resumeWithException(SecurityException())
            }
        }
    }
}

/** 唯一 SDK 适配点；媒体与声音路由使用官方实现，不另造 RTC 或设备管理器。 */
internal class QwSDKRoom(
    private val context: Context,
    private val requestPermission: QwPermissionRequest,
    private val publishedResources: (() -> List<QwResourceStop>)? = null,
    private val disconnectNative: (() -> Unit)? = null,
    private val detachResources: (() -> List<QwResourceStop>)? = null,
    private val restoreAudioNative: (() -> Unit)? = null,
    private val releaseNative: (() -> Unit)? = null,
    private val videoResource: ((FrameLayout) -> QwVideoResource)? = null,
) : QwRoomPort {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val sdkRoom by lazy {
        LiveKit.loggingLevel = LoggingLevel.OFF; LiveKit.enableWebRTCLogging = false
        LiveKit.create(context.applicationContext).also { it.audioSwitchHandler?.loggingEnabled = false }
    }
    private var retired = false
    private var released = false
    private var restoredAudio = false
    private var originalPreference: List<Class<out AudioDevice>>? = null
    private var preferenceCaptured = false
    private var preferredSpeaker = false
    private var events: Job? = null
    private var routeListener: AudioDeviceChangeListener? = null
    private class Renderer(val resource: QwVideoResource, val container: WeakReference<FrameLayout>) {
        var initialized = false
        var retiring = false
        var released = false
    }
    private val renderers = WeakHashMap<FrameLayout, Renderer>()
    // 容器可在 removeView 后销毁，但未确认释放的 native renderer 必须保留到下一次清理。
    private val ownedRenderers = LinkedHashSet<Renderer>()
    // 工厂同步创建 SDK，初始化失败由入口转受控错误；资源清理测试的窄端口不创建真实 SDK。
    init { if (disconnectNative == null) sdkRoom }
    override var eventHandler: ((QwRoomEvent) -> Unit)? = null
        set(value) {
            field = value; events?.cancel(); events = null
            routeListener?.let { sdkRoom.audioSwitchHandler?.unregisterAudioDeviceChangeListener(it) }; routeListener = null
            if (value != null && !retired) {
                events = scope.launch {
                    sdkRoom.events.collect { event ->
                        when (event) {
                            is RoomEvent.Connected, is RoomEvent.Reconnected -> deliver(QwRoomEvent.CONNECTED)
                            is RoomEvent.Reconnecting -> deliver(QwRoomEvent.RECONNECTING)
                            is RoomEvent.Disconnected -> deliver(QwRoomEvent.DISCONNECTED)
                            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected,
                            is RoomEvent.ParticipantNameChanged -> deliver(QwRoomEvent.PARTICIPANTS)
                            is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished, is RoomEvent.TrackSubscribed,
                            is RoomEvent.TrackUnsubscribed, is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted -> deliver(QwRoomEvent.TRACKS)
                            else -> Unit
                        }
                    }
                }
                routeListener = object : AudioDeviceChangeListener {
                    override fun invoke(audioDevices: List<AudioDevice>, selectedAudioDevice: AudioDevice?) {
                        scope.launch { deliver(QwRoomEvent.AUDIO_ROUTE) }
                    }
                }
                    .also { sdkRoom.audioSwitchHandler?.registerAudioDeviceChangeListener(it) }
            }
        }
    override val localIdentity get() = sdkRoom.localParticipant.identity?.value ?: ""
    override val microphone get() = sdkRoom.localParticipant.isMicrophoneEnabled
    override val camera get() = sdkRoom.localParticipant.isCameraEnabled
    override val speakerPreferred get() = preferredSpeaker
    override val participants: List<QwNativeParticipant>
        get() = (listOf(sdkRoom.localParticipant) + sdkRoom.remoteParticipants.values).mapNotNull { person ->
            person.identity?.value?.let { QwNativeParticipant(it, person.name ?: "", person === sdkRoom.localParticipant,
                person.isMicrophoneEnabled, person.isCameraEnabled) }
        }.sortedBy { it.identity }

    private fun alive() { check(!retired) }
    private suspend fun completed() {
        if (retired) { withContext(NonCancellable) { disconnect() }; throw kotlinx.coroutines.CancellationException() }
        currentCoroutineContext().ensureActive()
    }
    /** 授权发生在已登记的原生操作内；取消后迟到授权不能再打开设备。 */
    private suspend fun authorize(camera: Boolean) {
        val permission = if (camera) Manifest.permission.CAMERA else Manifest.permission.RECORD_AUDIO
        if (Build.VERSION.SDK_INT >= 23 && context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
            awaitQwPermission(camera, requestPermission)
        }
        alive(); currentCoroutineContext().ensureActive()
    }
    /** 连接后再次检查退休状态，取消不会遗留一个迟到接通的 Room。 */
    override suspend fun connect(url: String, token: String) { alive(); sdkRoom.connect(url, token); completed() }
    /** 授权成功且操作仍活跃时才启动官方麦克风。 */
    override suspend fun setMicrophone(enabled: Boolean) {
        alive(); if (enabled) authorize(false)
        check(sdkRoom.localParticipant.setMicrophoneEnabled(enabled)); completed()
    }
    /** 授权成功且操作仍活跃时才启动官方摄像头。 */
    override suspend fun setCamera(enabled: Boolean) {
        alive(); if (enabled) authorize(true)
        check(sdkRoom.localParticipant.setCameraEnabled(enabled)); completed()
    }
    /** 只切换已发布的本地 camera，不接触远端或屏幕轨道。 */
    override suspend fun switchCamera() {
        alive()
        val track = sdkRoom.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack ?: error("camera")
        track.switchCamera(); completed()
    }
    /** 只调整内置输出的优先级，蓝牙与有线设备仍由 SDK 优先处理。 */
    override suspend fun setSpeaker(preferred: Boolean) {
        alive()
        val audio = sdkRoom.audioSwitchHandler ?: error("audio route")
        if (!preferenceCaptured) { preferenceCaptured = true; originalPreference = audio.preferredDeviceList?.toList() }
        audio.preferredDeviceList = listOf(AudioDevice.BluetoothHeadset::class.java, AudioDevice.WiredHeadset::class.java) +
            if (preferred) listOf(AudioDevice.Speakerphone::class.java, AudioDevice.Earpiece::class.java)
            else listOf(AudioDevice.Earpiece::class.java, AudioDevice.Speakerphone::class.java)
        preferredSpeaker = preferred
    }
    /** 先切断事件源，不能让停止采集期间的 SDK 事件复活连接。 */
    override fun retire() { retired = true; eventHandler = null; scope.cancel() }

    /** 已断开的 SDK 仍可能迟到产生采集，故每次清理都重新停止当前 published tracks。 */
    override suspend fun disconnect() {
        var failed = false
        fun attempt(action: () -> Unit) {
            try { action() } catch (_: Exception) { failed = true }
        }
        var detach = emptyList<QwResourceStop>()
        attempt { detach = detachResources?.invoke() ?: ownedRenderers.toList().map { binding -> { releaseRenderer(binding) } } }
        detach.forEach { attempt(it) }
        var stops = emptyList<QwResourceStop>()
        attempt {
            stops = publishedResources?.invoke() ?: sdkRoom.localParticipant.trackPublications.values.mapNotNull { pub ->
                pub.track?.let { track -> { track.stop() } }
            }
        }
        // 每步独立尽力完成；只汇总固定错误，不把 SDK 敏感异常带到协程或脚本。
        stops.forEach { attempt(it) }
        attempt { if (disconnectNative != null) disconnectNative.invoke() else sdkRoom.disconnect() }
        if (!restoredAudio) attempt {
            if (restoreAudioNative != null) restoreAudioNative.invoke()
            else if (disconnectNative == null && preferenceCaptured) sdkRoom.audioSwitchHandler?.preferredDeviceList = originalPreference
            restoredAudio = true
        }
        if (!released) attempt {
            if (releaseNative != null) releaseNative.invoke() else if (disconnectNative == null) sdkRoom.release()
            released = true
        }
        if (failed) throw QwCleanupFailure()
    }
    /** 只展示 identity 对应的 camera track；renderer 留在同一个 SDK Room 内。 */
    override fun bind(view: FrameLayout, participantId: String) {
        if (retired) return
        val binding = renderers[view] ?: Renderer(
            videoResource?.invoke(view) ?: QwSDKVideoResource(view.context, sdkRoom), WeakReference(view),
        ).also { renderers[view] = it; ownedRenderers.add(it) }
        if (binding.retiring || binding.released) throw QwCleanupFailure()
        try {
            if (!binding.initialized) {
                binding.resource.initialize(); binding.initialized = true
                view.addView(binding.resource.view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            }
            binding.resource.bind(participantId)
        } catch (_: Exception) {
            binding.retiring = true
            throw QwCleanupFailure()
        }
    }
    /** 只解绑本容器的 renderer，不结束同一 Room 的其它画面或音轨。 */
    override fun unbind(view: FrameLayout) {
        val binding = renderers[view] ?: return
        releaseRenderer(binding)
    }
    private fun releaseRenderer(binding: Renderer) {
        binding.retiring = true
        var failed = false
        fun attempt(action: () -> Unit) { try { action() } catch (_: Exception) { failed = true } }
        attempt { binding.resource.unbind() }
        attempt { (binding.resource.view.parent as? ViewGroup)?.removeView(binding.resource.view) }
        if (!binding.released) attempt { binding.resource.release(); binding.released = true }
        if (failed) throw QwCleanupFailure()
        ownedRenderers.remove(binding)
        binding.container.get()?.let { if (renderers[it] === binding) renderers.remove(it) }
    }
    private fun deliver(event: QwRoomEvent) { if (!retired) eventHandler?.invoke(event) }
}

/** UTS 只接收标准容器与 JSON DTO；原生状态和脚本回调统一在主线程处理。 */
object QwLiveKitEngine {
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var context: Context? = null
    private var permissions: QwPermissionRequest? = null
    private val engine by lazy { QwNativeCoordinator(scope) { QwSDKRoom(requireNotNull(context), requireNotNull(permissions)) } }
    private fun <T> main(body: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return body()
        val task = FutureTask<T> { body() }
        handler.post(task)
        return task.get()
    }
    /** 仅保留应用 context；授权函数在调用时现取 Activity，避免跨页面持有旧宿主。 */
    @JvmStatic fun prepare(appContext: Context, requestPermission: (Boolean, (Boolean) -> Unit) -> Unit) {
        main { context = appContext.applicationContext; permissions = requestPermission }
    }
    /** 以宿主取得的短期凭据连接唯一原生 Room。 */
    @JvmStatic fun connect(url: String, token: String, microphone: Boolean, camera: Boolean,
                           success: (String) -> Unit, failure: (String, String) -> Unit) {
        main { engine.connect(url, token, microphone, camera, { success(it.json().toString()) }, { failure(it.code, it.operation) }) }
    }
    /** 只释放指定连接，旧编号不可结束新 Room。 */
    @JvmStatic fun disconnect(id: String, success: (String) -> Unit, failure: (String, String) -> Unit) {
        main { engine.disconnect(id, { success(it.json().toString()) }, { failure(it.code, it.operation) }) }
    }
    /** 当前连接的媒体操作串行化，错误只交受控 code/operation。 */
    @JvmStatic fun action(id: String, operation: String, enabled: Boolean, success: (String) -> Unit, failure: (String, String) -> Unit) {
        main { engine.action(id, operation, enabled, { success(it.json().toString()) }, { failure(it.code, it.operation) }) }
    }
    /** App 级外部订阅不持有任何原生 SDK 对象。 */
    @JvmStatic fun onEvent(callback: (String) -> Unit) { main { engine.observe { callback(it.json()) } } }
    /** 只停止脚本通知，内部断开处理保持有效。 */
    @JvmStatic fun offEvent() { main { engine.observe(null) } }
    @JvmStatic fun getSnapshot(): String = main { engine.snapshot.json().toString() }
    /** 标准容器交给 UTS，视频 renderer 仍留在 SDK 适配器中。 */
    @JvmStatic fun createVideoView(viewContext: Context): FrameLayout = main { FrameLayout(viewContext) }
    /** 只绑定当前连接和参与者的 camera。 */
    @JvmStatic fun bindVideoView(view: FrameLayout, connectionId: String, participantId: String) { main { engine.bind(view, connectionId, participantId) } }
    /** 组件卸载只释放该画面。 */
    @JvmStatic fun unbindVideoView(view: FrameLayout) { main { engine.unbind(view) } }
}
