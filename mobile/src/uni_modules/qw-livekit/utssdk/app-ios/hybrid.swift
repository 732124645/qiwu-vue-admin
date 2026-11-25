import Foundation
import UIKit
import AVFAudio
@preconcurrency import LiveKit

struct QwNativeParticipant: Codable, Equatable {
    let identity: String
    let name: String
    let local: Bool
    let microphone: Bool
    let camera: Bool
}

struct QwNativeSnapshot: Codable, Equatable {
    let connectionId: String
    let state: String
    let localIdentity: String
    let microphone: Bool
    let camera: Bool
    let speakerPreferred: Bool
    let participants: [QwNativeParticipant]
}

struct QwNativeFailure: Codable, Equatable {
    let code: String
    let operation: String
}

struct QwNativeEvent: Codable {
    let type: String
    let snapshot: QwNativeSnapshot
    let error: QwNativeFailure?

    private enum CodingKeys: String, CodingKey { case type, snapshot, error }
    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(type, forKey: .type)
        try fields.encode(snapshot, forKey: .snapshot)
        if let error { try fields.encode(error, forKey: .error) }
        else { try fields.encodeNil(forKey: .error) }
    }
}

enum QwRoomEvent { case connected, reconnecting, disconnected, participants, tracks, audioRoute }

/// 只替换原生 SDK 端口以检验生命周期，不把 Room、Track 或异步任务带到脚本桥。
@MainActor protocol QwRoomPort: AnyObject {
    var eventHandler: ((QwRoomEvent) -> Void)? { get set }
    var localIdentity: String { get }
    var microphone: Bool { get }
    var camera: Bool { get }
    var speakerPreferred: Bool { get }
    var participants: [QwNativeParticipant] { get }
    func connect(_ url: String, _ token: String) async throws
    func setMicrophone(_ enabled: Bool) async throws
    func setCamera(_ enabled: Bool) async throws
    func switchCamera() async throws
    func setSpeaker(_ preferred: Bool) async throws
    func retire()
    func disconnect() async
    func bind(_ view: UIView, _ participantId: String)
    func unbind(_ view: UIView)
}

/// 一次操作只有一个终局；取消后 SDK 即使迟到完成也不能再次调用脚本。
@MainActor private final class QwNativeOperation {
    let name: String
    private var success: ((QwNativeSnapshot) -> Void)?
    private var failure: ((QwNativeFailure) -> Void)?
    var task: Task<Void, Never>?

    init(_ name: String, _ success: @escaping (QwNativeSnapshot) -> Void, _ failure: @escaping (QwNativeFailure) -> Void) {
        self.name = name; self.success = success; self.failure = failure
    }
    func finish(_ snapshot: QwNativeSnapshot) {
        let callback = success; success = nil; failure = nil
        callback?(snapshot)
    }
    func fail(_ code: String) {
        let callback = failure; success = nil; failure = nil
        callback?(QwNativeFailure(code: code, operation: name))
    }
}

@MainActor private final class QwVideoBinding {
    let connectionId: String
    let participantId: String
    weak var room: (any QwRoomPort)?
    init(_ connectionId: String, _ participantId: String, _ room: any QwRoomPort) {
        self.connectionId = connectionId; self.participantId = participantId; self.room = room
    }
}

/// 同一个原生模块只持有一个 Room；连接编号与代次共同隔离退出后的回调。
@MainActor final class QwNativeCoordinator {
    private let makeRoom: () -> any QwRoomPort
    private var room: (any QwRoomPort)?
    private var generation: UInt64 = 0
    private var connectionId = ""
    private var state = "idle"
    private var pending: QwNativeOperation?
    private var closing: Task<Void, Never>?
    private var listener: ((QwNativeEvent) -> Void)?
    private let views = NSMapTable<UIView, QwVideoBinding>(keyOptions: .weakMemory, valueOptions: .strongMemory)

    init(makeRoom: @escaping () -> any QwRoomPort) { self.makeRoom = makeRoom }

    var snapshot: QwNativeSnapshot {
        QwNativeSnapshot(connectionId: connectionId, state: state, localIdentity: room?.localIdentity ?? "",
                         microphone: room?.microphone ?? false, camera: room?.camera ?? false,
                         speakerPreferred: room?.speakerPreferred ?? false, participants: room?.participants ?? [])
    }

    /// 外部订阅不决定 SDK 内部生命周期；停止监听只放下脚本闭包。
    func observe(_ callback: ((QwNativeEvent) -> Void)?) {
        listener = callback
    }

    private func emit(_ type: String, _ error: QwNativeFailure? = nil) {
        listener?(QwNativeEvent(type: type, snapshot: snapshot, error: error))
    }

    private func current(_ candidate: any QwRoomPort, _ at: UInt64) -> Bool {
        room === candidate && generation == at && state != "disconnecting" && state != "idle"
    }

    private func installEvents(_ candidate: any QwRoomPort, _ at: UInt64) {
        candidate.eventHandler = { [weak self, weak candidate] event in
            guard let self, let candidate, self.current(candidate, at) else { return }
            switch event {
            case .connected:
                if self.state == "reconnecting" { self.state = "connected"; self.emit("state") }
            case .reconnecting:
                if self.state == "connected" { self.state = "reconnecting"; self.emit("state") }
            case .disconnected: self.close(candidate, code: "DISCONNECTED", completion: nil)
            case .participants: self.refreshViews(); self.emit("participants")
            case .tracks: self.refreshViews(); self.emit("tracks")
            case .audioRoute: self.emit("audio-route")
            }
        }
    }

    /// 凭据仅进入官方 SDK；错误不包含原始 URL、token 或 SDK 异常正文。
    func connect(_ url: String, _ token: String, _ microphone: Bool, _ camera: Bool,
                 success: @escaping (QwNativeSnapshot) -> Void, failure: @escaping (QwNativeFailure) -> Void) {
        guard room == nil, state == "idle" else { failure(.init(code: "BUSY", operation: "connect")); return }
        guard let address = URLComponents(string: url), let host = address.host, !host.isEmpty,
              address.user == nil, address.password == nil, address.fragment == nil,
              address.scheme == "wss" || (address.scheme == "ws" && ["localhost", "127.0.0.1", "::1"].contains(host)),
              url.utf8.count <= 2048 else { failure(.init(code: "INVALID_URL", operation: "connect")); return }
        guard !token.isEmpty, token.utf8.count <= 16384,
              token.rangeOfCharacter(from: .controlCharacters) == nil else { failure(.init(code: "INVALID_TOKEN", operation: "connect")); return }
        generation &+= 1
        let at = generation, candidate = makeRoom()
        connectionId = UUID().uuidString
        room = candidate; state = "connecting"
        let operation = QwNativeOperation("connect", success, failure)
        pending = operation
        installEvents(candidate, at); emit("state")
        operation.task = Task { @MainActor [weak self, weak candidate] in
            guard let self, let candidate else { return }
            guard self.current(candidate, at), !Task.isCancelled else { return }
            do {
                try await candidate.connect(url, token)
                guard self.current(candidate, at), !Task.isCancelled else { await candidate.disconnect(); return }
                if microphone {
                    try await candidate.setMicrophone(true)
                    guard self.current(candidate, at), !Task.isCancelled else { await candidate.disconnect(); return }
                }
                if camera {
                    try await candidate.setCamera(true)
                    guard self.current(candidate, at), !Task.isCancelled else { await candidate.disconnect(); return }
                }
                self.pending = nil; self.state = "connected"
                self.refreshViews()
                let result = self.snapshot
                operation.finish(result)
                if self.current(candidate, at) { self.emit("state") }
            } catch {
                if self.current(candidate, at) { self.close(candidate, code: "SDK_ERROR", completion: nil) }
                else { await candidate.disconnect() }
            }
        }
    }

    /// 旧连接的停止请求不可结束后来建立的 Room。
    func disconnect(_ id: String, success: @escaping (QwNativeSnapshot) -> Void, failure: @escaping (QwNativeFailure) -> Void) {
        guard !id.isEmpty, id == connectionId else { failure(.init(code: "STALE_CONNECTION", operation: "disconnect")); return }
        guard state != "disconnecting" else { failure(.init(code: "BUSY", operation: "disconnect")); return }
        guard let room else { success(snapshot); return }
        close(room, code: "CANCELLED", completion: success)
    }

    /// 先退休并解绑，再异步关闭；释放完成之前不接受新连接。
    private func close(_ candidate: any QwRoomPort, code: String, completion: ((QwNativeSnapshot) -> Void)?) {
        generation &+= 1
        let at = generation
        state = "disconnecting"
        candidate.eventHandler = nil; candidate.retire()
        let operation = pending; pending = nil
        operation?.task?.cancel(); operation?.fail(code)
        for view in views.keyEnumerator().allObjects.compactMap({ $0 as? UIView }) { candidate.unbind(view) }
        emit("state")
        if code != "CANCELLED" { emit("error", .init(code: code, operation: operation?.name ?? "connection")) }
        closing = Task { @MainActor [weak self, weak candidate] in
            guard let self, let candidate else { return }
            await candidate.disconnect()
            guard self.room === candidate, self.generation == at else { return }
            self.room = nil; self.state = "idle"; self.closing = nil
            let result = self.snapshot
            self.emit("state"); completion?(result)
        }
    }

    /// 媒体开关串行化，避免后到的关闭先完成却被旧启用操作覆盖。
    func action(_ id: String, operation name: String, enabled: Bool = false,
                success: @escaping (QwNativeSnapshot) -> Void, failure: @escaping (QwNativeFailure) -> Void) {
        guard id == connectionId, let candidate = room else { failure(.init(code: "STALE_CONNECTION", operation: name)); return }
        guard state == "connected" else { failure(.init(code: "NOT_CONNECTED", operation: name)); return }
        guard pending == nil else { failure(.init(code: "BUSY", operation: name)); return }
        guard name != "switchCamera" || candidate.camera else { failure(.init(code: "NO_CAMERA", operation: name)); return }
        let at = generation, operation = QwNativeOperation(name, success, failure)
        pending = operation
        operation.task = Task { @MainActor [weak self, weak candidate] in
            guard let self, let candidate else { return }
            guard self.current(candidate, at), !Task.isCancelled else { return }
            do {
                switch name {
                case "setMicrophoneEnabled": try await candidate.setMicrophone(enabled)
                case "setCameraEnabled": try await candidate.setCamera(enabled)
                case "switchCamera": try await candidate.switchCamera()
                case "setSpeakerOutputPreferred": try await candidate.setSpeaker(enabled)
                default: throw CancellationError()
                }
                guard self.current(candidate, at), !Task.isCancelled else { await candidate.disconnect(); return }
                self.pending = nil; self.refreshViews()
                let result = self.snapshot
                operation.finish(result)
                if self.current(candidate, at) { self.emit(name == "setSpeakerOutputPreferred" ? "audio-route" : "tracks") }
            } catch {
                guard self.current(candidate, at) else { await candidate.disconnect(); return }
                self.pending = nil
                operation.fail("SDK_ERROR")
                if self.current(candidate, at) { self.emit("error", .init(code: "SDK_ERROR", operation: name)) }
            }
        }
    }

    /// 连接期间先登记视图意图，接通后自动绑定；tile 变更先解除原绑定。
    func bind(_ view: UIView, _ id: String, _ participantId: String) {
        unbind(view)
        guard id == connectionId, let room, ["connecting", "connected", "reconnecting"].contains(state) else { return }
        views.setObject(QwVideoBinding(id, participantId, room), forKey: view)
        if state != "connecting" { room.bind(view, participantId) }
    }

    func unbind(_ view: UIView) {
        views.object(forKey: view)?.room?.unbind(view)
        views.removeObject(forKey: view)
    }

    private func refreshViews() {
        guard let room, ["connected", "reconnecting"].contains(state) else { return }
        for view in views.keyEnumerator().allObjects.compactMap({ $0 as? UIView }) {
            guard let binding = views.object(forKey: view), binding.connectionId == connectionId, binding.room === room else { continue }
            room.bind(view, binding.participantId)
        }
    }
}

typealias QwPublishedResourceStop = @MainActor () async throws -> Void

/// 官方 SDK 的唯一适配点：媒体引擎、音频路由和摄像头切换都交给 SDK。
@MainActor final class QwSDKRoom: NSObject, QwRoomPort, RoomDelegate {
    private lazy var sdkRoom: Room = {
        LiveKitSDK.disableLogging()
        self.originalSpeaker = AudioManager.shared.isSpeakerOutputPreferred
        return Room()
    }()
    private var retired = false
    private var restoredAudio = false
    private var originalSpeaker: Bool?
    private let publishedResources: (() -> [QwPublishedResourceStop])?
    private let disconnectNative: (() async -> Void)?
    private var routeObserver: NSObjectProtocol?
    private let renderers = NSMapTable<UIView, VideoView>(keyOptions: .weakMemory, valueOptions: .weakMemory)
    var eventHandler: ((QwRoomEvent) -> Void)? {
        didSet {
            sdkRoom.remove(delegate: self)
            if let routeObserver { NotificationCenter.default.removeObserver(routeObserver); self.routeObserver = nil }
            if eventHandler != nil, !retired {
                sdkRoom.add(delegate: self)
                routeObserver = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.deliver(.audioRoute) }
                }
            }
        }
    }

    override init() {
        publishedResources = nil; disconnectNative = nil
        super.init()
    }

    /// 清理资源的窄端口让同一适配器可验证 SDK 已断开后的迟到资源，不改变媒体状态机。
    init(publishedResources: @escaping () -> [QwPublishedResourceStop], disconnectNative: @escaping () async -> Void) {
        self.publishedResources = publishedResources; self.disconnectNative = disconnectNative
        super.init()
    }
    var localIdentity: String { sdkRoom.localParticipant.identity?.stringValue ?? "" }
    var microphone: Bool { sdkRoom.localParticipant.isMicrophoneEnabled() }
    var camera: Bool { sdkRoom.localParticipant.isCameraEnabled() }
    var speakerPreferred: Bool { AudioManager.shared.isSpeakerOutputPreferred }
    var participants: [QwNativeParticipant] {
        let all: [Participant] = [sdkRoom.localParticipant] + Array(sdkRoom.remoteParticipants.values)
        return all.compactMap { participant in
            guard let identity = participant.identity?.stringValue else { return nil }
            return QwNativeParticipant(identity: identity, name: participant.name ?? "", local: participant === sdkRoom.localParticipant,
                                       microphone: participant.isMicrophoneEnabled(), camera: participant.isCameraEnabled())
        }.sorted { $0.identity < $1.identity }
    }
    private func alive() throws { if retired { throw CancellationError() } }
    private func completed() async throws {
        if retired { await disconnect(); throw CancellationError() }
    }
    func connect(_ url: String, _ token: String) async throws {
        try alive(); try await sdkRoom.connect(url: url, token: token); try await completed()
    }
    func setMicrophone(_ enabled: Bool) async throws {
        try alive(); try await sdkRoom.localParticipant.setMicrophone(enabled: enabled); try await completed()
    }
    func setCamera(_ enabled: Bool) async throws {
        try alive(); try await sdkRoom.localParticipant.setCamera(enabled: enabled); try await completed()
    }
    func switchCamera() async throws {
        try alive()
        guard let track = sdkRoom.localParticipant.videoTracks.first(where: { $0.source == .camera })?.track as? LocalVideoTrack,
              let camera = track.capturer as? CameraCapturer else { throw CancellationError() }
        try await camera.switchCameraPosition(); try await completed()
    }
    func setSpeaker(_ preferred: Bool) async throws {
        try alive(); AudioManager.shared.isSpeakerOutputPreferred = preferred
    }
    func retire() { retired = true; eventHandler = nil }

    private func stopPublishedTracks() async {
        let resources: [QwPublishedResourceStop]
        if let publishedResources { resources = publishedResources() }
        else {
            resources = sdkRoom.localParticipant.trackPublications.values.compactMap { publication in
                guard let track = publication.track else { return nil }
                return { try await track.stop() }
            }
        }
        // 单个资源停止失败也要继续停止其余采集，之后仍调用 SDK 的整体断开。
        for stop in resources { try? await stop() }
    }

    func disconnect() async {
        for view in renderers.keyEnumerator().allObjects.compactMap({ $0 as? UIView }) { unbind(view) }
        // SDK 操作可能在退休后迟到返回，不能只靠 Room 已断开的快速返回来停止本地采集。
        await stopPublishedTracks()
        if let disconnectNative { await disconnectNative() }
        else { await sdkRoom.disconnect() }
        if !restoredAudio {
            restoredAudio = true
            if let originalSpeaker { AudioManager.shared.isSpeakerOutputPreferred = originalSpeaker }
        }
    }
    func bind(_ view: UIView, _ participantId: String) {
        guard !retired else { return }
        let renderer: VideoView
        if let existing = renderers.object(forKey: view) { renderer = existing }
        else {
            renderer = VideoView(frame: view.bounds)
            renderer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(renderer); renderers.setObject(renderer, forKey: view)
        }
        let participant: Participant? = localIdentity == participantId ? sdkRoom.localParticipant : sdkRoom.remoteParticipants.values.first(where: { $0.identity?.stringValue == participantId })
        renderer.track = participant?.videoTracks.first(where: { $0.source == .camera })?.track as? VideoTrack
    }
    func unbind(_ view: UIView) {
        guard let renderer = renderers.object(forKey: view) else { return }
        renderer.track = nil; renderer.removeFromSuperview(); renderers.removeObject(forKey: view)
    }
    private func deliver(_ event: QwRoomEvent) { if !retired { eventHandler?(event) } }
    nonisolated private func post(_ event: QwRoomEvent) { Task { @MainActor [weak self] in self?.deliver(event) } }
    nonisolated func room(_ room: Room, didUpdateConnectionState state: ConnectionState, from oldState: ConnectionState) {
        switch state {
        case .connected: post(.connected)
        case .reconnecting: post(.reconnecting)
        case .disconnected: post(.disconnected)
        default: break
        }
    }
    nonisolated func roomIsReconnecting(_ room: Room) { post(.reconnecting) }
    nonisolated func roomDidReconnect(_ room: Room) { post(.connected) }
    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { post(.participants) }
    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { post(.participants) }
    nonisolated func room(_ room: Room, participant: Participant, didUpdateName name: String) { post(.participants) }
    nonisolated func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) { post(.tracks) }
    nonisolated func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) { post(.tracks) }
    nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) { post(.tracks) }
    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { post(.tracks) }
    nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) { post(.tracks) }
}

/// UTS 只访问基础字符串与标准 UIView；原生工作统一切到主线程后处理。
public final class QwLiveKitEngine: NSObject {
    @MainActor private static let engine = QwNativeCoordinator(makeRoom: { QwSDKRoom() })
    private static func main<T>(_ body: @MainActor () -> T) -> T {
        if Thread.isMainThread { return MainActor.assumeIsolated(body) }
        return DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
    }
    private static func json<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }
    /// 单独申请系统授权，录音任务可以在返回后复查代次，再决定是否开启采集。
    public static func requestMicrophonePermission(_ callback: @escaping (Bool) -> Void) {
        main { AVAudioSession.sharedInstance().requestRecordPermission { granted in main { callback(granted) } } }
    }
    /// 用宿主取得的凭据建立唯一连接，成功只返回受控媒体快照。
    public static func connect(_ url: String, _ token: String, _ microphone: Bool, _ camera: Bool,
                               _ success: @escaping (String) -> Void, _ failure: @escaping (String, String) -> Void) {
        main { engine.connect(url, token, microphone, camera, success: { success(json($0)) }, failure: { failure($0.code, $0.operation) }) }
    }
    /// 释放指定连接；过期编号不会触及当前连接。
    public static func disconnect(_ id: String, _ success: @escaping (String) -> Void, _ failure: @escaping (String, String) -> Void) {
        main { engine.disconnect(id, success: { success(json($0)) }, failure: { failure($0.code, $0.operation) }) }
    }
    /// 串行执行当前连接的媒体控制，错误不回显 SDK 异常。
    public static func action(_ id: String, _ operation: String, _ enabled: Bool,
                              _ success: @escaping (String) -> Void, _ failure: @escaping (String, String) -> Void) {
        main { engine.action(id, operation: operation, enabled: enabled, success: { success(json($0)) }, failure: { failure($0.code, $0.operation) }) }
    }
    /// 宿主 App 级监听只收到序列化后的状态，不持有原生对象。
    public static func onEvent(_ callback: @escaping (String) -> Void) { main { engine.observe { callback(json($0)) } } }
    /// 取消外部通知，内部仍跟踪断开并回收资源。
    public static func offEvent() { main { engine.observe(nil) } }
    public static func getSnapshot() -> String { main { json(engine.snapshot) } }
    /// 创建兼容组件的标准视图容器，SDK renderer 留在原生适配器内。
    public static func createVideoView() -> UIView { main { UIView(frame: .zero) } }
    /// 绑定指定连接和参与者的摄像头画面，重连后由原生 registry 更新。
    public static func bindVideoView(_ view: UIView, _ connectionId: String, _ participantId: String) { main { engine.bind(view, connectionId, participantId) } }
    /// 组件卸载只解除画面，不结束其它参与者或声音。
    public static func unbindVideoView(_ view: UIView) { main { engine.unbind(view) } }
}
