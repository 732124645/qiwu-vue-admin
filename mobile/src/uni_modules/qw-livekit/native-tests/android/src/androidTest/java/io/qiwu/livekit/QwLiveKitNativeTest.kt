package io.qiwu.livekit

import android.content.Context
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.ArrayDeque
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** SDK 等待故意不响应取消；真正的 Android 主线程、容器与协程保持不替换。 */
private class TestRoom : QwRoomPort {
    override var eventHandler: ((QwRoomEvent) -> Unit)? = null
    override val localIdentity = "alice"
    override var microphone = false
    override var camera = false
    override var speakerPreferred = false
    var connected = false
    var creations = 0
    var connects = 0
    var disconnects = 0
    var microphoneSets = 0
    var cameraSets = 0
    var switches = 0
    var retired = false
    var connectError: Exception? = null
    var microphoneError: Exception? = null
    var disconnectError: Exception? = null
    var retireError: Exception? = null
    var unbindError: Exception? = null
    var bindErrorFor: FrameLayout? = null
    var unbindErrorFor: FrameLayout? = null
    var bindFatalError: Error? = null
    var pauseConnect = false
    var pauseMicrophone = false
    var pauseCamera = false
    var pauseDisconnect = false
    val connectGates = ArrayDeque<Continuation<Unit>>()
    val microphoneGates = ArrayDeque<Continuation<Unit>>()
    val cameraGates = ArrayDeque<Continuation<Unit>>()
    val disconnectGates = ArrayDeque<Continuation<Unit>>()
    val binds = mutableListOf<Pair<FrameLayout, String>>()
    val bindAttempts = mutableListOf<Pair<FrameLayout, String>>()
    val unbinds = mutableListOf<FrameLayout>()
    override val participants get() = if (connected) listOf(QwNativeParticipant("alice", "Alice", true, microphone, camera)) else emptyList()
    override suspend fun connect(url: String, token: String) {
        connects++
        if (pauseConnect) suspendCoroutine<Unit> { connectGates.add(it) }
        connectError?.let { throw it }
        connected = true
    }
    override suspend fun setMicrophone(enabled: Boolean) {
        microphoneSets++
        if (pauseMicrophone) suspendCoroutine<Unit> { microphoneGates.add(it) }
        microphoneError?.let { throw it }
        microphone = enabled
    }
    override suspend fun setCamera(enabled: Boolean) {
        cameraSets++
        if (pauseCamera) suspendCoroutine<Unit> { cameraGates.add(it) }
        camera = enabled
    }
    override suspend fun switchCamera() { switches++ }
    override suspend fun setSpeaker(preferred: Boolean) { speakerPreferred = preferred }
    override fun retire() { retired = true; retireError?.let { throw it } }
    override suspend fun disconnect() {
        disconnects++
        if (pauseDisconnect) suspendCoroutine<Unit> { disconnectGates.add(it) }
        disconnectError?.let { throw it }
        connected = false; microphone = false; camera = false
    }
    override fun bind(view: FrameLayout, participantId: String) {
        bindAttempts.add(view to participantId)
        bindFatalError?.let { throw it }
        if (view === bindErrorFor) throw IllegalStateException("private SDK renderer secret-token")
        binds.add(view to participantId)
    }
    override fun unbind(view: FrameLayout) {
        unbinds.add(view)
        if (view === unbindErrorFor) throw IllegalStateException("private SDK detach secret-token")
        unbindError?.let { throw it }
    }
    fun resumeAll() {
        pauseConnect = false; pauseMicrophone = false; pauseCamera = false; pauseDisconnect = false
        listOf(connectGates, microphoneGates, cameraGates, disconnectGates).forEach { gates ->
            while (gates.isNotEmpty()) gates.removeFirst().resume(Unit)
        }
    }
}

/** 使用真实 Android View，只让官方 renderer 资源调用的返回/失败可控。 */
private class TestVideoResource(context: Context) : QwVideoResource {
    override val view: View = FrameLayout(context)
    var initialized = 0
    var releases = 0
    var releaseAttempts = 0
    var failRelease = false
    val participants = mutableListOf<String>()
    override fun initialize() { initialized++ }
    override fun bind(participantId: String) { participants.add(participantId) }
    override fun unbind() = Unit
    override fun release() {
        releaseAttempts++
        if (failRelease) throw IllegalStateException("private renderer release secret-token")
        releases++
    }
}

/** 回调只记录证据；JUnit 断言必须在测试控制流，不能被生产的脚本异常隔离吞掉。 */
private class Result {
    val successes = mutableListOf<QwNativeSnapshot>()
    val failures = mutableListOf<QwNativeFailure>()
    val successOnMain = mutableListOf<Boolean>()
    val success: (QwNativeSnapshot) -> Unit = { successes.add(it); successOnMain.add(Looper.myLooper() == Looper.getMainLooper()) }
    val failure: (QwNativeFailure) -> Unit = { failures.add(it) }
    val terminal get() = successes.isNotEmpty() || failures.isNotEmpty()
}

@RunWith(AndroidJUnit4::class)
class QwLiveKitNativeTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val unhandled = mutableListOf<Throwable>()
    /** 等待已记录的终局；未受控协程异常会直接失败，不只靠等待超时。 */
    private suspend fun awaitResult(condition: () -> Boolean) = withTimeout(2000) {
        while (!condition() && unhandled.isEmpty()) yield()
        assertTrue("Native coroutine escaped controlled handling", unhandled.isEmpty())
    }
    private fun native(block: suspend (CoroutineScope) -> Unit) = runBlocking {
        val handler = CoroutineExceptionHandler { _, error -> unhandled.add(error) }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + handler)
        try { withContext(Dispatchers.Main.immediate) { block(scope); assertTrue(unhandled.isEmpty()) } }
        finally { withContext(NonCancellable + Dispatchers.Main.immediate) { scope.cancel() } }
    }
    private fun engine(scope: CoroutineScope, rooms: List<TestRoom>): QwNativeCoordinator {
        var next = 0
        return QwNativeCoordinator(scope) {
            // 多余创建由计数断言暴露，不让数组越界充当业务失败。
            rooms[minOf(next++, rooms.lastIndex)].also { it.creations++ }
        }
    }
    private fun assertSuccess(result: Result, state: String) {
        assertEquals(1, result.successes.size); assertTrue(result.failures.isEmpty())
        assertEquals(listOf(true), result.successOnMain); assertEquals(state, result.successes.single().state)
    }
    private fun assertFailure(result: Result, code: String, operation: String) {
        assertTrue(result.successes.isEmpty()); assertEquals(listOf(QwNativeFailure(code, operation)), result.failures)
    }
    private suspend fun connect(engine: QwNativeCoordinator, microphone: Boolean = false, camera: Boolean = false) {
        val result = Result()
        engine.connect("wss://media.example.test", "test-token", microphone, camera, result.success, result.failure)
        awaitResult { result.terminal }; assertSuccess(result, "connected")
    }
    private suspend fun disconnect(engine: QwNativeCoordinator) {
        val result = Result()
        engine.disconnect(engine.snapshot.connectionId, result.success, result.failure)
        awaitResult { result.terminal }; assertSuccess(result, "idle")
    }

    @Test fun requestedMediaAndOnlyOneRoom() = native { scope ->
        val first = TestRoom(); val second = TestRoom(); val engine = engine(scope, listOf(first, second))
        connect(engine, microphone = true)
        val id = engine.snapshot.connectionId
        assertTrue(first.microphone); assertFalse(first.camera)
        val result = Result()
        engine.connect("wss://other.example.test", "next-token", true, true, result.success, result.failure)
        assertFailure(result, "BUSY", "connect")
        assertEquals(id, engine.snapshot.connectionId); assertEquals(1, first.creations); assertEquals(0, second.creations)
        disconnect(engine)
    }
    private fun rejects(scope: CoroutineScope, url: String, token: String, code: String) {
        var creations = 0
        val engine = QwNativeCoordinator(scope) { creations++; TestRoom() }; val result = Result()
        engine.connect(url, token, false, false, result.success, result.failure)
        assertFailure(result, code, "connect"); assertEquals(0, creations)
    }
    @Test fun invalidURLSchemesCredentialsAndFragmentsNeverCreateARoom() = native { scope ->
        listOf("https://media.example.test", "ws://media.example.test", "wss://user:password@media.example.test",
            "wss://user@media.example.test", "wss://media.example.test/#fragment").forEach { rejects(scope, it, "token", "INVALID_URL") }
    }
    @Test fun overlongURLNeverCreatesARoom() = native { scope -> rejects(scope, "wss://media.example.test/" + "a".repeat(2048), "token", "INVALID_URL") }
    @Test fun overlongTokenNeverCreatesARoom() = native { scope -> rejects(scope, "wss://media.example.test", "a".repeat(16385), "INVALID_TOKEN") }
    @Test fun emptyOrControlTokenNeverCreatesARoom() = native { scope ->
        listOf("", "secret\nvalue", "secret\u0000value").forEach { rejects(scope, "wss://media.example.test", it, "INVALID_TOKEN") }
    }

    @Test fun connectingListenerCanCancelBeforeSDKStarts() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); val result = Result(); val closed = Result()
        engine.observe { event -> if (event.snapshot.state == "connecting") engine.disconnect(event.snapshot.connectionId, closed.success, closed.failure) }
        engine.connect("wss://media.example.test", "token", true, true, result.success, result.failure)
        awaitResult { result.terminal && closed.terminal }
        assertFailure(result, "CANCELLED", "connect"); assertSuccess(closed, "idle"); assertEquals(0, room.connects)
    }
    /** 分别停在三个初始化等待点，SDK 忽略取消也不能开后续设备或回填成功。 */
    private suspend fun cancelledStage(scope: CoroutineScope, stage: String) {
        val room = TestRoom().apply {
            pauseConnect = stage == "connect"; pauseMicrophone = stage == "microphone"; pauseCamera = stage == "camera"
        }
        val engine = engine(scope, listOf(room)); val result = Result()
        engine.connect("wss://media.example.test", "token", true, true, result.success, result.failure)
        awaitResult { when (stage) { "connect" -> room.connectGates.isNotEmpty(); "microphone" -> room.microphoneGates.isNotEmpty(); else -> room.cameraGates.isNotEmpty() } }
        disconnect(engine); room.resumeAll(); awaitResult { room.disconnects >= 2 }
        assertEquals("idle", engine.snapshot.state); assertFailure(result, "CANCELLED", "connect")
        assertFalse(room.microphone); assertFalse(room.camera)
        if (stage == "connect") assertEquals(0, room.microphoneSets)
        if (stage != "camera") assertEquals(0, room.cameraSets)
    }
    @Test fun cancellationAfterConnectNeverStartsCapture() = native { cancelledStage(it, "connect") }
    @Test fun cancellationAfterMicrophoneNeverStartsCamera() = native { cancelledStage(it, "microphone") }
    @Test fun cancellationAfterCameraNeverRestoresTheConnection() = native { cancelledStage(it, "camera") }

    @Test fun lateOldRoomCannotReplaceTheNewConnectionOrBindItsView() = native { scope ->
        val first = TestRoom().apply { pauseConnect = true }; val second = TestRoom()
        val engine = engine(scope, listOf(first, second)); val result = Result()
        engine.connect("wss://media.example.test", "token", false, false, result.success, result.failure)
        awaitResult { first.connectGates.isNotEmpty() }
        val oldId = engine.snapshot.connectionId; val view = FrameLayout(context)
        engine.bind(view, oldId, "alice"); val oldHandler = first.eventHandler
        disconnect(engine); connect(engine); val nextId = engine.snapshot.connectionId
        first.resumeAll(); oldHandler?.invoke(QwRoomEvent.TRACKS); second.eventHandler?.invoke(QwRoomEvent.TRACKS)
        awaitResult { first.disconnects >= 2 }
        assertFailure(result, "CANCELLED", "connect"); assertEquals(nextId, engine.snapshot.connectionId)
        assertEquals("connected", engine.snapshot.state); assertTrue(second.binds.isEmpty())
        val stale = Result(); engine.disconnect(oldId, stale.success, stale.failure)
        assertFailure(stale, "STALE_CONNECTION", "disconnect"); assertEquals(0, second.disconnects)
        engine.bind(view, nextId, "bob"); assertEquals(view to "bob", second.binds.last()); disconnect(engine)
    }

    @Test fun disconnectWaitsForReleaseAndRetiresLateCameraEnable() = native { scope ->
        val room = TestRoom(); val other = TestRoom(); val engine = engine(scope, listOf(room, other)); connect(engine)
        room.pauseCamera = true; room.pauseDisconnect = true
        val action = Result(); val closed = Result(); val duplicate = Result(); val replacement = Result()
        engine.action(engine.snapshot.connectionId, "setCameraEnabled", true, action.success, action.failure)
        awaitResult { room.cameraGates.isNotEmpty() }
        engine.disconnect(engine.snapshot.connectionId, closed.success, closed.failure)
        assertEquals("disconnecting", engine.snapshot.state)
        engine.connect("wss://media.example.test", "token", false, false, replacement.success, replacement.failure)
        assertFailure(replacement, "BUSY", "connect"); assertEquals(0, other.creations)
        engine.disconnect(engine.snapshot.connectionId, duplicate.success, duplicate.failure)
        assertFailure(duplicate, "BUSY", "disconnect")
        room.resumeAll(); awaitResult { closed.terminal && room.disconnects >= 2 }
        assertSuccess(closed, "idle"); assertFailure(action, "CANCELLED", "setCameraEnabled"); assertFalse(room.camera)
    }
    @Test fun nativeEventsStillReleaseWithoutExternalSubscription() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); val events = mutableListOf<QwNativeEvent>()
        engine.observe { events.add(it) }; connect(engine); engine.observe(null); val before = events.size
        room.eventHandler?.invoke(QwRoomEvent.DISCONNECTED); awaitResult { engine.snapshot.state == "idle" }
        assertEquals(before, events.size); assertTrue(room.retired); assertEquals(1, room.disconnects)
    }
    @Test fun connectingViewsWaitForReadyAndUnmountedIntentNeverRevives() = native { scope ->
        val room = TestRoom().apply { pauseConnect = true }; val engine = engine(scope, listOf(room)); val result = Result()
        engine.connect("wss://media.example.test", "token", false, false, result.success, result.failure)
        awaitResult { room.connectGates.isNotEmpty() }
        val keep = FrameLayout(context); val removed = FrameLayout(context); val id = engine.snapshot.connectionId
        engine.bind(keep, id, "alice"); engine.bind(removed, id, "bob"); engine.unbind(removed)
        room.eventHandler?.invoke(QwRoomEvent.PARTICIPANTS); room.eventHandler?.invoke(QwRoomEvent.TRACKS)
        assertTrue(room.binds.isEmpty()); room.resumeAll(); awaitResult { result.terminal }; assertSuccess(result, "connected")
        assertEquals(listOf(keep to "alice"), room.binds)
        engine.bind(keep, id, "bob"); assertEquals(keep to "bob", room.binds.last()); engine.unbind(keep); val before = room.binds.size
        room.eventHandler?.invoke(QwRoomEvent.TRACKS); assertEquals(before, room.binds.size); assertEquals(0, room.disconnects); disconnect(engine)
    }
    @Test fun mediaControlsAreSerializedAndRejectedChangeDoesNotEndOtherMedia() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine, camera = true)
        room.microphoneError = IllegalStateException("private SDK error"); val failed = Result()
        engine.action(engine.snapshot.connectionId, "setMicrophoneEnabled", true, failed.success, failed.failure)
        awaitResult { failed.terminal }; assertFailure(failed, "SDK_ERROR", "setMicrophoneEnabled")
        assertEquals("connected", engine.snapshot.state); assertTrue(room.camera); assertEquals(0, room.disconnects)
        room.microphoneError = null; room.pauseCamera = true; val first = Result(); val busy = Result()
        engine.action(engine.snapshot.connectionId, "setCameraEnabled", false, first.success, first.failure)
        awaitResult { room.cameraGates.isNotEmpty() }
        engine.action(engine.snapshot.connectionId, "setMicrophoneEnabled", true, busy.success, busy.failure)
        assertFailure(busy, "BUSY", "setMicrophoneEnabled")
        room.resumeAll(); awaitResult { first.terminal }; assertSuccess(first, "connected"); assertFalse(engine.snapshot.camera); disconnect(engine)
    }
    @Test fun cameraSwitchRequiresCameraAndSpeakerReturnsRequestedPreference() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine); val camera = Result(); val speaker = Result()
        engine.action(engine.snapshot.connectionId, "switchCamera", false, camera.success, camera.failure)
        assertFailure(camera, "NO_CAMERA", "switchCamera"); assertEquals(0, room.switches)
        engine.action(engine.snapshot.connectionId, "setSpeakerOutputPreferred", true, speaker.success, speaker.failure)
        awaitResult { speaker.terminal }; assertSuccess(speaker, "connected"); assertTrue(speaker.successes.single().speakerPreferred); disconnect(engine)
    }
    @Test fun controlledErrorsAndEventsNeverContainSDKCredentials() = native { scope ->
        val room = TestRoom().apply { connectError = IllegalStateException("wss://secret.example.test secret-token") }
        val engine = engine(scope, listOf(room)); val events = mutableListOf<String>(); val result = Result()
        engine.observe { events.add(it.json()) }
        engine.connect("wss://secret.example.test", "secret-token", false, false, result.success, result.failure)
        awaitResult { result.terminal && engine.snapshot.state == "idle" }; assertFailure(result, "SDK_ERROR", "connect")
        assertFalse(events.joinToString().contains("secret")); assertTrue(JSONObject(events.first()).has("error")); assertTrue(JSONObject(events.first()).isNull("error"))
    }
    @Test fun reentrantCompletionKeepsItsOriginalSnapshotAndRunsOnce() = native { scope ->
        val first = TestRoom(); val second = TestRoom(); val engine = engine(scope, listOf(first, second)); connect(engine)
        val originalId = engine.snapshot.connectionId; val closed = Result(); val replacement = Result()
        engine.observe { event ->
            if (event.snapshot.state == "idle") engine.connect("wss://media.example.test", "token", false, false, replacement.success, replacement.failure)
        }
        engine.disconnect(originalId, closed.success, closed.failure)
        awaitResult { closed.terminal && replacement.terminal }; assertSuccess(closed, "idle"); assertSuccess(replacement, "connected")
        assertEquals(originalId, closed.successes.single().connectionId); assertNotEquals(originalId, engine.snapshot.connectionId)
        engine.observe(null); disconnect(engine)
    }
    /** 真实事件监听可在视图失败时重入关闭/重连，旧操作仍须返回原连接快照。 */
    private suspend fun viewFailureCannotReplaceCompletion(scope: CoroutineScope, duringConnect: Boolean) {
        val first = TestRoom().apply { pauseConnect = duringConnect }; val next = TestRoom()
        val engine = engine(scope, listOf(first, next)); val view = FrameLayout(context)
        val closed = Result(); val replacement = Result(); val completion = Result()
        var originalId = ""; var switched = false
        engine.observe { event ->
            if (event.error?.operation == "bindVideoView" && !switched) {
                switched = true
                engine.disconnect(originalId, {
                    closed.success(it)
                    engine.connect("wss://media.example.test", "next-token", false, false, replacement.success, replacement.failure)
                }, closed.failure)
            }
        }
        if (duringConnect) {
            engine.connect("wss://media.example.test", "token", false, false, completion.success, completion.failure)
            awaitResult { first.connectGates.isNotEmpty() }
        } else connect(engine)
        originalId = engine.snapshot.connectionId
        engine.bind(view, originalId, "alice"); first.bindErrorFor = view
        if (duringConnect) first.resumeAll()
        else engine.action(originalId, "setSpeakerOutputPreferred", true, completion.success, completion.failure)
        awaitResult { completion.terminal && replacement.terminal }
        assertSuccess(completion, "connected"); assertEquals(originalId, completion.successes.single().connectionId)
        assertSuccess(closed, "idle"); assertSuccess(replacement, "connected")
        assertNotEquals(originalId, engine.snapshot.connectionId); disconnect(engine)
    }
    @Test fun viewFailureListenerCannotReplaceConnectCompletionSnapshot() = native { viewFailureCannotReplaceCompletion(it, true) }
    @Test fun viewFailureListenerCannotReplaceActionCompletionSnapshot() = native { viewFailureCannotReplaceCompletion(it, false) }

    @Test fun permissionRepliesCompleteOnceAndLateGrantCannotResumeCancelledOperation() = native { scope ->
        var reply: ((Boolean) -> Unit)? = null; var requestedCamera: Boolean? = null; var started = 0
        val job = scope.launch { awaitQwPermission(true) { camera, callback -> requestedCamera = camera; reply = callback }; started++ }
        awaitResult { reply != null }; assertEquals(true, requestedCamera)
        job.cancel(); reply!!(true); reply!!(false); job.join(); assertEquals(0, started)
        var denied = 0
        try { awaitQwPermission(false) { _, callback -> callback(false); callback(true) } } catch (_: SecurityException) { denied++ }
        assertEquals(1, denied); awaitQwPermission(false) { _, callback -> callback(true); callback(false) }
    }
    @Test fun realAdapterStopsEveryResourceBeforeDisconnectEvenAfterEarlierDisconnect() = native { _ ->
        val order = mutableListOf<String>(); var resources = emptyList<QwResourceStop>(); var sdkClosed = false
        val room = QwSDKRoom(context, { _, reply -> reply(false) }, { resources }, {
            order.add(if (sdkClosed) "already-disconnected" else "disconnect"); sdkClosed = true
        })
        room.disconnect(); assertTrue(sdkClosed); order.clear()
        resources = listOf({ order.add("first") }, { order.add("throws"); throw IllegalStateException("private SDK detail") }, { order.add("last") })
        var failure: Exception? = null
        try { room.disconnect() } catch (error: Exception) { failure = error }
        assertNotNull(failure); assertNull(failure!!.cause); assertFalse(failure!!.message.orEmpty().contains("private"))
        assertEquals(listOf("first", "throws", "last", "already-disconnected"), order)
    }

    @Test fun cleanupFailureKeepsSlotAndSameConnectionCanRetryWithoutLeakingSDKError() = native { scope ->
        val room = TestRoom(); val other = TestRoom(); val engine = engine(scope, listOf(room, other)); connect(engine)
        val id = engine.snapshot.connectionId; val result = Result(); val events = mutableListOf<String>()
        engine.observe { events.add(it.json()) }; room.disconnectError = IllegalStateException("wss://private.example.test secret-token")
        engine.disconnect(id, result.success, result.failure); awaitResult { result.terminal }
        assertFailure(result, "SDK_ERROR", "disconnect"); assertEquals("disconnecting", engine.snapshot.state); assertEquals(id, engine.snapshot.connectionId)
        assertTrue(room.connected); assertFalse(events.joinToString().contains("private")); assertFalse(events.joinToString().contains("secret-token"))
        val replacement = Result(); engine.connect("wss://media.example.test", "token", false, false, replacement.success, replacement.failure)
        assertFailure(replacement, "BUSY", "connect"); assertEquals(0, other.creations)
        room.disconnectError = null; val retry = Result(); engine.disconnect(id, retry.success, retry.failure); awaitResult { retry.terminal }
        assertSuccess(retry, "idle"); assertEquals(id, retry.successes.single().connectionId); assertEquals(1, result.failures.size)
    }
    @Test fun failedSDKEventCleanupIsControlledAndCanBeRetried() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); val events = mutableListOf<QwNativeEvent>(); connect(engine)
        engine.observe { events.add(it) }; room.disconnectError = IllegalStateException("private media error")
        room.eventHandler?.invoke(QwRoomEvent.DISCONNECTED)
        awaitResult { events.any { it.error == QwNativeFailure("SDK_ERROR", "disconnect") } }
        assertEquals("disconnecting", engine.snapshot.state); assertFalse(events.joinToString { it.json() }.contains("private"))
        engine.observe(null); room.disconnectError = null; disconnect(engine)
    }
    @Test fun earlyRetireOrViewFailureStillAttemptsDisconnectAndKeepsTheSlotForRetry() = native { scope ->
        for (stage in listOf("retire", "view")) {
            val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine)
            engine.bind(FrameLayout(context), engine.snapshot.connectionId, "alice")
            if (stage == "retire") room.retireError = IllegalStateException("private retire detail")
            else room.unbindError = IllegalStateException("private renderer detail")
            val result = Result(); engine.disconnect(engine.snapshot.connectionId, result.success, result.failure)
            awaitResult { result.terminal }; assertFailure(result, "SDK_ERROR", "disconnect")
            assertEquals(1, room.disconnects); assertEquals("disconnecting", engine.snapshot.state)
            room.retireError = null; room.unbindError = null; disconnect(engine); assertEquals(2, room.disconnects)
        }
    }
    @Test fun failedLateCleanupNeverChangesNewRoomOrEmitsItsErrorThere() = native { scope ->
        val old = TestRoom().apply { pauseConnect = true }; val next = TestRoom(); val engine = engine(scope, listOf(old, next)); val oldResult = Result()
        engine.connect("wss://media.example.test", "token", false, false, oldResult.success, oldResult.failure)
        awaitResult { old.connectGates.isNotEmpty() }; disconnect(engine); connect(engine)
        val id = engine.snapshot.connectionId; val events = mutableListOf<QwNativeEvent>(); engine.observe { events.add(it) }
        old.disconnectError = IllegalStateException("secret late cleanup"); old.resumeAll(); awaitResult { old.disconnects >= 2 }; yield()
        assertFailure(oldResult, "CANCELLED", "connect"); assertEquals(id, engine.snapshot.connectionId); assertEquals("connected", engine.snapshot.state)
        assertTrue(events.isEmpty()); assertEquals(0, next.disconnects); engine.observe(null); disconnect(engine)
    }
    @Test fun adapterAttemptsEveryCleanupStepAndRetriesUnconfirmedReleaseAndAudioRestore() = native { _ ->
        val order = mutableListOf<String>(); var failSteps = true
        val room = QwSDKRoom(context, { _, reply -> reply(false) },
            publishedResources = { listOf({ order.add("track-fails"); if (failSteps) throw IllegalStateException("secret track") }, { order.add("track-last") }) },
            disconnectNative = { order.add("disconnect"); if (failSteps) throw IllegalStateException("secret disconnect") },
            detachResources = { listOf({ order.add("detach-fails"); if (failSteps) throw IllegalStateException("secret view") }, { order.add("detach-last") }) },
            restoreAudioNative = { order.add("audio"); if (failSteps) throw IllegalStateException("secret audio") },
            releaseNative = { order.add("release"); if (failSteps) throw IllegalStateException("secret release") })
        var failure: Exception? = null
        try { room.disconnect() } catch (error: Exception) { failure = error }
        val all = listOf("detach-fails", "detach-last", "track-fails", "track-last", "disconnect", "audio", "release")
        assertEquals(all, order); assertNotNull(failure); assertNull(failure!!.cause); assertFalse(failure!!.message.orEmpty().contains("secret"))
        failSteps = false; order.clear(); room.disconnect(); assertEquals(all, order)
        order.clear(); room.disconnect(); assertEquals(all.dropLast(2), order)
    }

    @Test fun failedRendererRemainsOwnedAfterDetachAndContainerDestructionUntilReleaseConfirms() = native { _ ->
        val failed = TestVideoResource(context); val other = TestVideoResource(context)
        var created = 0; var disconnects = 0
        val room = QwSDKRoom(context, { _, reply -> reply(false) }, publishedResources = { emptyList() },
            disconnectNative = { disconnects++ }, videoResource = { if (created++ == 0) failed else other })
        var container: FrameLayout? = FrameLayout(context)
        val second = FrameLayout(context)
        room.bind(container!!, "alice"); room.bind(second, "bob")
        failed.failRelease = true
        var error: Exception? = null
        try { room.unbind(container!!) } catch (caught: Exception) { error = caught }
        assertNotNull(error); assertNull(error!!.cause); assertFalse(error!!.message.orEmpty().contains("secret"))
        assertNull(failed.view.parent); assertEquals(1, failed.releaseAttempts); assertEquals(0, failed.releases)
        error = null
        try { room.bind(container!!, "carol") } catch (caught: Exception) { error = caught }
        assertNotNull(error); assertEquals(listOf("alice"), failed.participants)
        // 宿主不再保留原容器；后续关闭必须通过独立资源记录清理，不能只遍历容器表。
        container = null
        error = null
        try { room.disconnect() } catch (caught: Exception) { error = caught }
        assertNotNull(error); assertEquals(2, failed.releaseAttempts); assertEquals(0, failed.releases)
        assertEquals(1, other.releases); assertEquals(1, disconnects)
        failed.failRelease = false
        room.disconnect()
        assertEquals(3, failed.releaseAttempts); assertEquals(1, failed.releases); assertEquals(1, other.releases)
        room.disconnect()
        assertEquals(3, failed.releaseAttempts); assertEquals(1, other.releases); assertEquals(2, created)
    }

    @Test fun publicViewFailuresAreControlledAndFailedDetachCannotBindAnotherIdentity() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine)
        val first = FrameLayout(context); val other = FrameLayout(context); val events = mutableListOf<QwNativeEvent>()
        val id = engine.snapshot.connectionId
        engine.observe { events.add(it) }; room.bindErrorFor = first
        engine.bind(first, id, "alice")
        assertEquals(listOf(QwNativeFailure("SDK_ERROR", "bindVideoView")), events.mapNotNull { it.error })
        engine.bind(other, id, "bob"); assertEquals(other to "bob", room.binds.last())
        room.bindErrorFor = null; room.unbindErrorFor = first
        val attempts = room.bindAttempts.size
        engine.bind(first, id, "carol")
        assertEquals(attempts, room.bindAttempts.size)
        assertEquals(QwNativeFailure("SDK_ERROR", "unbindVideoView"), events.last().error)
        assertFalse(engine.unbind(first))
        engine.bind(other, id, "dave"); assertEquals(other to "dave", room.binds.last())
        assertEquals("connected", engine.snapshot.state); assertEquals(0, room.disconnects)
        assertFalse(events.joinToString { it.json() }.contains("secret-token"))
        assertFalse(events.joinToString { it.json() }.contains("private"))
        room.unbindErrorFor = null
        assertTrue(engine.unbind(first)); disconnect(engine)
    }

    @Test fun SDKTrackRefreshIsolatesOneFailedViewAndContinuesOtherViews() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine)
        val first = FrameLayout(context); val second = FrameLayout(context); val events = mutableListOf<QwNativeEvent>()
        val id = engine.snapshot.connectionId
        engine.bind(first, id, "alice"); engine.bind(second, id, "bob")
        room.binds.clear(); room.bindAttempts.clear(); room.bindErrorFor = first; engine.observe { events.add(it) }
        room.eventHandler?.invoke(QwRoomEvent.TRACKS)
        assertEquals(listOf(second to "bob"), room.binds)
        assertEquals(2, room.bindAttempts.size)
        assertEquals(listOf(QwNativeFailure("SDK_ERROR", "bindVideoView")), events.mapNotNull { it.error })
        assertFalse(events.joinToString { it.json() }.contains("secret-token"))
        assertEquals("connected", engine.snapshot.state); assertEquals(0, room.disconnects)
        room.bindErrorFor = null; disconnect(engine)
    }

    @Test fun JVMErrorsFromVideoOperationsAreNotMistakenForControlledSDKErrors() = native { scope ->
        val room = TestRoom(); val engine = engine(scope, listOf(room)); connect(engine)
        val fatal = AssertionError("fatal renderer error"); room.bindFatalError = fatal
        var observed: Error? = null
        try { engine.bind(FrameLayout(context), engine.snapshot.connectionId, "alice") } catch (error: Error) { observed = error }
        assertSame(fatal, observed)
        room.bindFatalError = null; disconnect(engine)
    }
}
