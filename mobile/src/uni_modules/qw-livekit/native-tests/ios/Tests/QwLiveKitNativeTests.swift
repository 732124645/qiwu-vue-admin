import XCTest
import UIKit
@testable import QwLiveKitNative

/// 延迟 SDK 返回故意不响应 Task.cancel，用于证明原生协调器会拒绝迟到结果。
@MainActor private final class TestRoom: QwRoomPort {
    var eventHandler: ((QwRoomEvent) -> Void)?
    let localIdentity = "alice"
    var microphone = false
    var camera = false
    var speakerPreferred = false
    var connected = false
    var retired = false
    var disconnects = 0
    var completedDisconnects = 0
    var connects = 0
    var creations = 0
    var microphoneSets = 0
    var cameraSets = 0
    var binds: [(UIView, String)] = []
    var unbinds: [UIView] = []
    var connectError: Error?
    var microphoneError: Error?
    var pauseConnect = false
    var pauseMicrophone = false
    var pauseCamera = false
    var pauseDisconnect = false
    private var connectGates: [CheckedContinuation<Void, Error>] = []
    private var microphoneGates: [CheckedContinuation<Void, Error>] = []
    private var cameraGates: [CheckedContinuation<Void, Error>] = []
    private var disconnectGates: [CheckedContinuation<Void, Never>] = []
    var didStartConnect: XCTestExpectation?
    var didStartMicrophone: XCTestExpectation?
    var didStartCamera: XCTestExpectation?
    var didStartDisconnect: XCTestExpectation?

    var participants: [QwNativeParticipant] {
        connected ? [.init(identity: localIdentity, name: "Alice", local: true, microphone: microphone, camera: camera)] : []
    }
    func connect(_ url: String, _ token: String) async throws {
        connects += 1
        didStartConnect?.fulfill()
        if pauseConnect { try await withCheckedThrowingContinuation { connectGates.append($0) } }
        if let connectError { throw connectError }
        connected = true
    }
    func setMicrophone(_ enabled: Bool) async throws {
        microphoneSets += 1
        didStartMicrophone?.fulfill(); didStartMicrophone = nil
        if pauseMicrophone { try await withCheckedThrowingContinuation { microphoneGates.append($0) } }
        if let microphoneError { throw microphoneError }
        microphone = enabled
    }
    func setCamera(_ enabled: Bool) async throws {
        cameraSets += 1
        didStartCamera?.fulfill()
        if pauseCamera { try await withCheckedThrowingContinuation { cameraGates.append($0) } }
        camera = enabled
    }
    func switchCamera() async throws {}
    func setSpeaker(_ preferred: Bool) async throws { speakerPreferred = preferred }
    func retire() { retired = true }
    func disconnect() async {
        disconnects += 1
        connected = false; microphone = false; camera = false
        didStartDisconnect?.fulfill(); didStartDisconnect = nil
        if pauseDisconnect { await withCheckedContinuation { disconnectGates.append($0) } }
        completedDisconnects += 1
    }
    /// 假 SDK 不因取消而结束；显式恢复全部等待者，重复关闭也不会覆盖 continuation。
    func resumeConnects() {
        pauseConnect = false
        let waiting = connectGates; connectGates = []
        for gate in waiting { gate.resume() }
    }
    func resumeMicrophones() {
        pauseMicrophone = false
        let waiting = microphoneGates; microphoneGates = []
        for gate in waiting { gate.resume() }
    }
    func resumeCameras() {
        pauseCamera = false
        let waiting = cameraGates; cameraGates = []
        for gate in waiting { gate.resume() }
    }
    func resumeDisconnects() {
        pauseDisconnect = false
        let waiting = disconnectGates; disconnectGates = []
        for gate in waiting { gate.resume() }
    }
    func bind(_ view: UIView, _ participantId: String) { binds.append((view, participantId)) }
    func unbind(_ view: UIView) { unbinds.append(view) }
}

@MainActor final class QwLiveKitNativeTests: XCTestCase {
    func testSDKAdapterStopsLatePublishedMediaEvenWhenSDKDisconnectIsAlreadyANoop() async {
        var resources: [QwPublishedResourceStop] = []
        var sdkDisconnected = false, lateTrackActive = true, stops = 0
        var order: [String] = []
        let adapter = QwSDKRoom(publishedResources: { resources }, disconnectNative: {
            if sdkDisconnected { order.append("already-disconnected"); return }
            sdkDisconnected = true; order.append("disconnect")
        })
        await adapter.disconnect()
        XCTAssertTrue(sdkDisconnected)
        resources = [{ stops += 1; lateTrackActive = false; order.append("stop") }]
        order.removeAll()
        await adapter.disconnect()
        XCTAssertEqual(stops, 1)
        XCTAssertFalse(lateTrackActive)
        XCTAssertEqual(order, ["stop", "already-disconnected"])
    }

    func testSDKAdapterContinuesOtherResourceStopsAndNativeDisconnectAfterOneStopThrows() async {
        var order: [String] = []
        let adapter = QwSDKRoom(publishedResources: {
            [
                { order.append("first") },
                { order.append("throws"); throw NSError(domain: "media stop", code: 1) },
                { order.append("last") },
            ]
        }, disconnectNative: { order.append("disconnect") })
        await adapter.disconnect()
        XCTAssertEqual(order, ["first", "throws", "last", "disconnect"])
    }

    private func coordinator(_ rooms: [TestRoom]) -> QwNativeCoordinator {
        var next = 0
        return QwNativeCoordinator {
            // 多余创建由用例的计数断言发现，不用数组越界代替业务失败。
            let room = rooms[min(next, rooms.count - 1)]
            next += 1; room.creations += 1
            return room
        }
    }

    /// 只让出主线程等待原生分支的确定终点；正常清理与错误复活都会结束等待，之后再核对行为。
    private func waitForNativeResult(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<1000 {
            if condition() { return }
            await Task.yield()
        }
        XCTFail("Native operation did not reach an observable result", file: file, line: line)
    }

    private func connect(_ engine: QwNativeCoordinator, microphone: Bool = false, camera: Bool = false) async {
        let ready = expectation(description: "connected")
        engine.connect("wss://media.example.test", "test-token", microphone, camera, success: { snapshot in
            XCTAssertTrue(Thread.isMainThread)
            XCTAssertEqual(snapshot.state, "connected")
            ready.fulfill()
        }, failure: { error in XCTFail("Unexpected controlled failure: \(error.code)") })
        await fulfillment(of: [ready], timeout: 2)
    }

    private func disconnect(_ engine: QwNativeCoordinator) async {
        let closed = expectation(description: "disconnected")
        engine.disconnect(engine.snapshot.connectionId, success: { snapshot in
            XCTAssertEqual(snapshot.state, "idle"); closed.fulfill()
        }, failure: { error in XCTFail("Unexpected controlled failure: \(error.code)") })
        await fulfillment(of: [closed], timeout: 2)
    }

    func testConnectPublishesOnlyRequestedMediaAndRejectsASecondRoom() async {
        let room = TestRoom(), second = TestRoom(), engine = coordinator([room, second])
        await connect(engine, microphone: true)
        XCTAssertTrue(room.microphone); XCTAssertFalse(room.camera)
        let originalId = engine.snapshot.connectionId
        var error: QwNativeFailure?
        engine.connect("wss://other.example.test", "another-token", true, true, success: { _ in XCTFail() }, failure: { error = $0 })
        XCTAssertEqual(error, .init(code: "BUSY", operation: "connect"))
        XCTAssertEqual(engine.snapshot.connectionId, originalId)
        XCTAssertEqual(room.connects, 1)
        XCTAssertEqual(room.creations, 1); XCTAssertEqual(second.creations, 0)
        await disconnect(engine)
    }

    func testInvalidInputsNeverCreateASDKRoom() {
        var creations = 0
        let engine = QwNativeCoordinator { creations += 1; return TestRoom() }
        var failures: [QwNativeFailure] = []
        for url in ["https://media.example.test", "ws://media.example.test", "wss://user:password@media.example.test", "wss://media.example.test/#fragment"] {
            engine.connect(url, "test-token", false, false, success: { _ in XCTFail() }, failure: { failures.append($0) })
        }
        engine.connect("wss://media.example.test", "", false, false, success: { _ in XCTFail() }, failure: { failures.append($0) })
        XCTAssertEqual(creations, 0)
        XCTAssertEqual(failures.map(\.code), ["INVALID_URL", "INVALID_URL", "INVALID_URL", "INVALID_URL", "INVALID_TOKEN"])
    }

    private func rejectsInput(_ url: String, _ token: String, code: String, file: StaticString = #filePath, line: UInt = #line) {
        var creations = 0, failures: [QwNativeFailure] = []
        let engine = QwNativeCoordinator { creations += 1; return TestRoom() }
        engine.connect(url, token, false, false, success: { _ in XCTFail("Invalid input connected", file: file, line: line) }, failure: { failures.append($0) })
        XCTAssertEqual(failures, [.init(code: code, operation: "connect")], file: file, line: line)
        XCTAssertEqual(creations, 0, file: file, line: line)
        XCTAssertEqual(engine.snapshot.state, "idle", file: file, line: line)
    }

    func testURLOverTheByteLimitNeverCreatesARoom() {
        let url = "wss://media.example.test/" + String(repeating: "a", count: 2048)
        XCTAssertGreaterThan(url.utf8.count, 2048)
        rejectsInput(url, "test-token", code: "INVALID_URL")
    }

    func testTokenOverTheByteLimitNeverCreatesARoom() {
        rejectsInput("wss://media.example.test", String(repeating: "a", count: 16385), code: "INVALID_TOKEN")
    }

    func testTokenWithAControlCharacterNeverCreatesARoom() {
        rejectsInput("wss://media.example.test", "test-\u{000A}token", code: "INVALID_TOKEN")
    }

    func testURLWithAUsernameAndNoPasswordNeverCreatesARoom() {
        rejectsInput("wss://user@media.example.test", "test-token", code: "INVALID_URL")
    }

    func testAnEventWithoutFailureStillCarriesTheRequiredNullErrorField() throws {
        let engine = coordinator([TestRoom()])
        let event = QwNativeEvent(type: "state", snapshot: engine.snapshot, error: nil)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as! [String: Any]
        XCTAssertTrue(object["error"] is NSNull)
    }

    func testDisconnectBeforeTheConnectTaskStartsNeverCallsTheSDK() async {
        let room = TestRoom(), engine = coordinator([room])
        var cancellations: [QwNativeFailure] = []
        engine.connect("wss://media.example.test", "test-token", true, true, success: { _ in XCTFail() }, failure: { cancellations.append($0) })
        await disconnect(engine)
        XCTAssertEqual(room.connects, 0)
        XCTAssertEqual(room.cameraSets, 0)
        XCTAssertEqual(cancellations, [.init(code: "CANCELLED", operation: "connect")])
    }

    func testAConnectingListenerCanCancelBeforeTheTaskIsStored() async {
        let room = TestRoom(), engine = coordinator([room])
        let stopped = expectation(description: "cancelled by state listener")
        engine.observe { event in
            if event.snapshot.state == "connecting" {
                engine.disconnect(event.snapshot.connectionId, success: { _ in stopped.fulfill() }, failure: { _ in XCTFail() })
            }
        }
        var failures: [QwNativeFailure] = []
        engine.connect("wss://media.example.test", "test-token", true, true, success: { _ in XCTFail() }, failure: { failures.append($0) })
        await fulfillment(of: [stopped], timeout: 2)
        XCTAssertEqual(room.connects, 0)
        XCTAssertEqual(failures, [.init(code: "CANCELLED", operation: "connect")])
    }

    func testAQueuedCameraTaskCannotStartAfterDisconnect() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine)
        var failures: [QwNativeFailure] = []
        engine.action(engine.snapshot.connectionId, operation: "setCameraEnabled", enabled: true, success: { _ in XCTFail() }, failure: { failures.append($0) })
        await disconnect(engine)
        XCTAssertEqual(room.cameraSets, 0)
        XCTAssertEqual(failures, [.init(code: "CANCELLED", operation: "setCameraEnabled")])
    }

    private enum InitialSDKStep: Equatable { case connect, microphone, camera }

    /// 分别卡住初始化的三个 SDK 等待点；退休后假端口仍照常完成，调用次数能发现瞬间开麦或开相机。
    private func cancelsInitialization(at step: InitialSDKStep) async {
        let room = TestRoom(), engine = coordinator([room])
        let started = expectation(description: "initial SDK operation suspended")
        switch step {
        case .connect: room.pauseConnect = true; room.didStartConnect = started
        case .microphone: room.pauseMicrophone = true; room.didStartMicrophone = started
        case .camera: room.pauseCamera = true; room.didStartCamera = started
        }
        var successes = 0, failures: [QwNativeFailure] = []
        engine.connect("wss://media.example.test", "test-token", true, true, success: { _ in successes += 1 }, failure: { failures.append($0) })
        await fulfillment(of: [started], timeout: 2)
        await disconnect(engine)
        XCTAssertEqual(engine.snapshot.state, "idle")
        XCTAssertTrue(room.retired)
        XCTAssertEqual(failures, [.init(code: "CANCELLED", operation: "connect")])
        switch step {
        case .connect: room.resumeConnects()
        case .microphone: room.resumeMicrophones()
        case .camera: room.resumeCameras()
        }
        // 正常路径会再次清理迟到 SDK；错误路径若复活到 connected 也立即停止等待并由下面的断言指出。
        await waitForNativeResult { room.completedDisconnects >= 2 || engine.snapshot.state != "idle" }
        XCTAssertEqual(room.microphoneSets, step == .connect ? 0 : 1)
        XCTAssertEqual(room.cameraSets, step == .camera ? 1 : 0)
        XCTAssertEqual(successes, 0)
        XCTAssertEqual(engine.snapshot.state, "idle")
        XCTAssertFalse(engine.snapshot.microphone); XCTAssertFalse(engine.snapshot.camera)
        XCTAssertFalse(room.connected); XCTAssertFalse(room.microphone); XCTAssertFalse(room.camera)
        XCTAssertEqual(failures, [.init(code: "CANCELLED", operation: "connect")])
    }

    func testCancellationAfterSDKConnectNeverStartsInitialMicrophoneOrCamera() async {
        await cancelsInitialization(at: .connect)
    }

    func testCancellationAfterInitialMicrophoneNeverStartsTheInitialCamera() async {
        await cancelsInitialization(at: .microphone)
    }

    func testCancellationAfterInitialCameraCannotRestoreTheConnection() async {
        await cancelsInitialization(at: .camera)
    }

    func testLateConnectCannotReplaceTheNextRoomOrFireSuccess() async {
        let first = TestRoom(), second = TestRoom(), engine = coordinator([first, second])
        first.pauseConnect = true
        let started = expectation(description: "first connect started")
        first.didStartConnect = started
        var oldSuccesses = 0, oldFailures: [QwNativeFailure] = []
        engine.connect("wss://media.example.test", "test-token", true, true, success: { _ in oldSuccesses += 1 }, failure: { oldFailures.append($0) })
        let firstId = engine.snapshot.connectionId
        await fulfillment(of: [started], timeout: 2)
        var premature: QwNativeFailure?
        engine.action(firstId, operation: "setMicrophoneEnabled", enabled: true, success: { _ in XCTFail() }, failure: { premature = $0 })
        XCTAssertEqual(premature?.code, "NOT_CONNECTED")
        let oldEvent = first.eventHandler
        await disconnect(engine)
        await connect(engine, microphone: true)
        let secondId = engine.snapshot.connectionId
        XCTAssertNotEqual(firstId, secondId)
        let cleaned = expectation(description: "late connection cleaned")
        first.didStartDisconnect = cleaned
        first.resumeConnects()
        await fulfillment(of: [cleaned], timeout: 2)
        oldEvent?(.disconnected)
        XCTAssertEqual(oldSuccesses, 0)
        XCTAssertEqual(oldFailures, [.init(code: "CANCELLED", operation: "connect")])
        XCTAssertFalse(first.connected)
        XCTAssertTrue(second.connected); XCTAssertTrue(second.microphone)
        XCTAssertEqual(engine.snapshot.connectionId, secondId)
        var oldStop: QwNativeFailure?
        engine.disconnect(firstId, success: { _ in XCTFail() }, failure: { oldStop = $0 })
        XCTAssertEqual(oldStop?.code, "STALE_CONNECTION")
        XCTAssertEqual(second.disconnects, 0)
        var oldAction: QwNativeFailure?
        engine.action(firstId, operation: "setMicrophoneEnabled", enabled: false, success: { _ in XCTFail() }, failure: { oldAction = $0 })
        XCTAssertEqual(oldAction?.code, "STALE_CONNECTION")
        XCTAssertTrue(second.microphone)
        await disconnect(engine)
    }

    func testDisconnectWaitsForReleaseAndRetiresALateCameraEnable() async {
        let room = TestRoom(), second = TestRoom(), engine = coordinator([room, second])
        await connect(engine)
        room.pauseCamera = true
        let cameraStarted = expectation(description: "camera started")
        room.didStartCamera = cameraStarted
        var successes = 0, failures: [QwNativeFailure] = []
        engine.action(engine.snapshot.connectionId, operation: "setCameraEnabled", enabled: true, success: { _ in successes += 1 }, failure: { failures.append($0) })
        await fulfillment(of: [cameraStarted], timeout: 2)
        var busyAction: QwNativeFailure?
        engine.action(engine.snapshot.connectionId, operation: "setMicrophoneEnabled", enabled: true, success: { _ in XCTFail() }, failure: { busyAction = $0 })
        XCTAssertEqual(busyAction?.code, "BUSY")
        room.pauseDisconnect = true
        let releaseStarted = expectation(description: "release started")
        room.didStartDisconnect = releaseStarted
        let closed = expectation(description: "closed")
        engine.disconnect(engine.snapshot.connectionId, success: { _ in closed.fulfill() }, failure: { _ in XCTFail() })
        await fulfillment(of: [releaseStarted], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "disconnecting")
        XCTAssertTrue(room.retired)
        var busy: QwNativeFailure?
        engine.connect("wss://media.example.test", "test-token", false, false, success: { _ in XCTFail() }, failure: { busy = $0 })
        XCTAssertEqual(busy?.code, "BUSY")
        XCTAssertEqual(room.creations, 1); XCTAssertEqual(second.creations, 0)
        room.resumeDisconnects()
        await fulfillment(of: [closed], timeout: 2)
        let lateCameraStopped = expectation(description: "late camera stopped")
        room.didStartDisconnect = lateCameraStopped
        room.resumeCameras()
        await fulfillment(of: [lateCameraStopped], timeout: 2)
        XCTAssertFalse(room.camera)
        XCTAssertEqual(successes, 0)
        XCTAssertEqual(failures, [.init(code: "CANCELLED", operation: "setCameraEnabled")])
        XCTAssertEqual(engine.snapshot.state, "idle")
    }

    func testASecondDisconnectWhileReleaseIsSuspendedIsBusyAndOnlyTheFirstCompletes() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine)
        let id = engine.snapshot.connectionId
        room.pauseDisconnect = true
        let releasing = expectation(description: "first release suspended")
        room.didStartDisconnect = releasing
        let completed = expectation(description: "a disconnect callback completed")
        var firstSuccesses = 0, secondSuccesses = 0
        var firstFailures: [QwNativeFailure] = [], secondFailures: [QwNativeFailure] = []
        engine.disconnect(id, success: { snapshot in
            XCTAssertEqual(snapshot.state, "idle")
            firstSuccesses += 1
            if firstSuccesses + secondSuccesses == 1 { completed.fulfill() }
        }, failure: { firstFailures.append($0) })
        await fulfillment(of: [releasing], timeout: 2)
        engine.disconnect(id, success: { _ in
            secondSuccesses += 1
            if firstSuccesses + secondSuccesses == 1 { completed.fulfill() }
        }, failure: { secondFailures.append($0) })
        XCTAssertEqual(engine.snapshot.state, "disconnecting")
        XCTAssertEqual(secondFailures, [.init(code: "BUSY", operation: "disconnect")])
        room.resumeDisconnects()
        // 假端口会恢复全部关闭请求；即使错误地进入第二次 close，也用回调数量失败而非挂住。
        await fulfillment(of: [completed], timeout: 2)
        await waitForNativeResult { room.completedDisconnects == room.disconnects && engine.snapshot.state == "idle" }
        XCTAssertEqual(firstSuccesses, 1); XCTAssertEqual(secondSuccesses, 0)
        XCTAssertTrue(firstFailures.isEmpty)
        XCTAssertEqual(secondFailures, [.init(code: "BUSY", operation: "disconnect")])
        XCTAssertEqual(room.disconnects, 1)
    }

    func testOffStopsScriptEventsWhileNativeDisconnectionStillReleasesTheRoom() async {
        let room = TestRoom(), engine = coordinator([room])
        var events: [QwNativeEvent] = []
        engine.observe { events.append($0) }
        await connect(engine)
        room.eventHandler?(.participants); room.eventHandler?(.tracks)
        XCTAssertEqual(events.suffix(2).map(\.type), ["participants", "tracks"])
        engine.observe(nil)
        XCTAssertNotNil(room.eventHandler)
        let count = events.count
        room.eventHandler?(.reconnecting)
        XCTAssertEqual(events.count, count)
        let stopped = expectation(description: "native disconnection completed")
        room.didStartDisconnect = stopped
        room.eventHandler?(.disconnected)
        await fulfillment(of: [stopped], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "idle")
        XCTAssertTrue(room.retired)
        XCTAssertEqual(events.count, count)
        XCTAssertNil(room.eventHandler)
    }

    func testNativeDisconnectionIsProcessedWithoutAnyScriptSubscription() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine)
        let stopped = expectation(description: "native room released")
        room.didStartDisconnect = stopped
        room.eventHandler?(.disconnected)
        await fulfillment(of: [stopped], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "idle")
        XCTAssertEqual(room.disconnects, 1)
    }

    func testATileLoadedWhileConnectingBindsAfterConnectUnlessItWasUnmounted() async {
        let room = TestRoom(), engine = coordinator([room])
        let view = UIView(), removed = UIView()
        room.pauseConnect = true
        let started = expectation(description: "SDK connect suspended")
        room.didStartConnect = started
        let ready = expectation(description: "connection and pending tile ready")
        engine.connect("wss://media.example.test", "test-token", false, false, success: { snapshot in
            XCTAssertEqual(snapshot.state, "connected")
            ready.fulfill()
        }, failure: { _ in XCTFail() })
        await fulfillment(of: [started], timeout: 2)
        let id = engine.snapshot.connectionId
        XCTAssertFalse(id.isEmpty)
        XCTAssertEqual(engine.snapshot.state, "connecting")
        engine.bind(view, id, "alice")
        engine.bind(removed, id, "bob")
        engine.unbind(removed)
        room.eventHandler?(.participants); room.eventHandler?(.tracks)
        XCTAssertTrue(room.binds.isEmpty)
        room.resumeConnects()
        await fulfillment(of: [ready], timeout: 2)
        XCTAssertEqual(engine.snapshot.connectionId, id)
        XCTAssertEqual(room.binds.count, 1)
        XCTAssertTrue(room.binds.first?.0 === view)
        XCTAssertEqual(room.binds.first?.1, "alice")
        XCTAssertFalse(room.binds.contains { $0.0 === removed })
        await disconnect(engine)
    }

    func testRendererRebindAndUnmountNeverEndTheRoom() async {
        let room = TestRoom(), engine = coordinator([room]), view = UIView()
        engine.observe { _ in }
        await connect(engine)
        let id = engine.snapshot.connectionId
        engine.bind(view, "foreign-connection", "alice")
        XCTAssertTrue(room.binds.isEmpty)
        engine.bind(view, id, "alice")
        XCTAssertEqual(room.binds.last?.1, "alice")
        engine.bind(view, id, "bob")
        XCTAssertTrue(room.unbinds.last === view)
        XCTAssertEqual(room.binds.last?.1, "bob")
        room.eventHandler?(.tracks)
        XCTAssertEqual(room.binds.last?.1, "bob")
        engine.unbind(view)
        let count = room.binds.count
        room.eventHandler?(.tracks)
        XCTAssertEqual(room.binds.count, count)
        XCTAssertEqual(room.disconnects, 0)
        let other = UIView()
        engine.bind(other, id, "alice")
        await disconnect(engine)
        XCTAssertTrue(room.unbinds.contains { $0 === other })
    }

    func testATileFromThePreviousConnectionCannotReceiveTheNextRoomsTracks() async {
        let first = TestRoom(), second = TestRoom(), engine = coordinator([first, second])
        let view = UIView()
        await connect(engine, camera: true)
        let oldId = engine.snapshot.connectionId
        engine.bind(view, oldId, "alice")
        XCTAssertEqual(first.binds.count, 1)
        await disconnect(engine)
        XCTAssertTrue(first.unbinds.contains { $0 === view })
        await connect(engine, camera: true)
        let newId = engine.snapshot.connectionId
        XCTAssertNotEqual(oldId, newId)
        second.eventHandler?(.participants); second.eventHandler?(.tracks)
        XCTAssertTrue(second.binds.isEmpty)
        XCTAssertEqual(first.binds.count, 1)
        engine.bind(view, newId, "bob")
        XCTAssertEqual(second.binds.count, 1)
        XCTAssertTrue(second.binds.last?.0 === view)
        XCTAssertEqual(second.binds.last?.1, "bob")
        second.eventHandler?(.participants); second.eventHandler?(.tracks)
        XCTAssertEqual(second.binds.count, 3)
        XCTAssertTrue(second.binds.allSatisfy { $0.0 === view && $0.1 == "bob" })
        await disconnect(engine)
    }

    func testARejectedMediaToggleIsControlledAndDoesNotEndTheOtherMedia() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine, camera: true)
        room.microphoneError = NSError(domain: "private SDK error", code: 1)
        let failed = expectation(description: "media rejected")
        engine.action(engine.snapshot.connectionId, operation: "setMicrophoneEnabled", enabled: true, success: { _ in XCTFail() }, failure: { error in
            XCTAssertEqual(error, .init(code: "SDK_ERROR", operation: "setMicrophoneEnabled"))
            failed.fulfill()
        })
        await fulfillment(of: [failed], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "connected")
        XCTAssertTrue(room.camera); XCTAssertFalse(room.microphone)
        XCTAssertEqual(room.disconnects, 0)
        await disconnect(engine)
    }

    func testCameraSwitchRequiresAnEnabledCameraAndSpeakerPreferenceReturnsItsSnapshot() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine)
        var denied: QwNativeFailure?
        engine.action(engine.snapshot.connectionId, operation: "switchCamera", success: { _ in XCTFail() }, failure: { denied = $0 })
        XCTAssertEqual(denied, .init(code: "NO_CAMERA", operation: "switchCamera"))
        let routed = expectation(description: "speaker preference set")
        engine.action(engine.snapshot.connectionId, operation: "setSpeakerOutputPreferred", enabled: true, success: { snapshot in
            XCTAssertTrue(snapshot.speakerPreferred); routed.fulfill()
        }, failure: { _ in XCTFail() })
        await fulfillment(of: [routed], timeout: 2)
        await disconnect(engine)
    }

    func testControlledErrorsNeverIncludeTheSDKErrorOrCredentials() async {
        let room = TestRoom(), engine = coordinator([room])
        room.connectError = NSError(domain: "test", code: 42, userInfo: [NSLocalizedDescriptionKey: "private-token wss://private.example.test"])
        var events: [QwNativeEvent] = [], failures: [QwNativeFailure] = []
        engine.observe { events.append($0) }
        let failed = expectation(description: "controlled error")
        let idle = expectation(description: "failed room released")
        engine.observe { event in
            events.append(event)
            if event.snapshot.state == "idle" { idle.fulfill() }
        }
        engine.connect("wss://media.example.test", "private-token", true, false, success: { _ in XCTFail() }, failure: { failures.append($0); failed.fulfill() })
        await fulfillment(of: [failed, idle], timeout: 2)
        XCTAssertEqual(failures, [.init(code: "SDK_ERROR", operation: "connect")])
        let encoded = String(data: try! JSONEncoder().encode(events), encoding: .utf8)!
        XCTAssertFalse(encoded.contains("private-token")); XCTAssertFalse(encoded.contains("private.example.test"))
        XCTAssertEqual(engine.snapshot.state, "idle")
    }

    func testReentrantDisconnectCompletionStillReportsTheConnectionItClosed() async {
        let first = TestRoom(), second = TestRoom(), engine = coordinator([first, second])
        await connect(engine)
        let firstId = engine.snapshot.connectionId
        let replacementReady = expectation(description: "replacement connected")
        var replacementStarted = false
        engine.observe { event in
            if event.snapshot.state == "idle", !replacementStarted {
                replacementStarted = true
                engine.connect("wss://media.example.test", "test-token", false, false, success: { _ in replacementReady.fulfill() }, failure: { _ in XCTFail() })
            }
        }
        let stopped = expectation(description: "original connection stopped")
        engine.disconnect(firstId, success: { snapshot in
            XCTAssertEqual(snapshot.connectionId, firstId)
            XCTAssertEqual(snapshot.state, "idle")
            stopped.fulfill()
        }, failure: { _ in XCTFail() })
        await fulfillment(of: [stopped, replacementReady], timeout: 2)
        engine.observe(nil)
        await disconnect(engine)
    }

    func testAStateListenerCannotReplaceTheConnectCompletionSnapshot() async {
        let room = TestRoom(), engine = coordinator([room])
        let ready = expectation(description: "connect result"), stopped = expectation(description: "listener stopped room")
        engine.observe { event in
            if event.snapshot.state == "connected" {
                engine.disconnect(event.snapshot.connectionId, success: { _ in stopped.fulfill() }, failure: { _ in XCTFail() })
            }
        }
        engine.connect("wss://media.example.test", "test-token", false, false, success: { snapshot in
            XCTAssertEqual(snapshot.state, "connected")
            XCTAssertFalse(snapshot.connectionId.isEmpty)
            ready.fulfill()
        }, failure: { _ in XCTFail() })
        await fulfillment(of: [ready, stopped], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "idle")
    }

    func testATrackListenerCannotChangeTheActionCompletionToDisconnecting() async {
        let room = TestRoom(), engine = coordinator([room])
        await connect(engine)
        let id = engine.snapshot.connectionId
        let changed = expectation(description: "media action result"), stopped = expectation(description: "track listener stopped room")
        engine.observe { event in
            if event.type == "tracks" {
                engine.disconnect(id, success: { _ in stopped.fulfill() }, failure: { _ in XCTFail() })
            }
        }
        engine.action(id, operation: "setMicrophoneEnabled", enabled: true, success: { snapshot in
            XCTAssertEqual(snapshot.connectionId, id)
            XCTAssertEqual(snapshot.state, "connected")
            XCTAssertTrue(snapshot.microphone)
            changed.fulfill()
        }, failure: { _ in XCTFail() })
        await fulfillment(of: [changed, stopped], timeout: 2)
        XCTAssertEqual(engine.snapshot.state, "idle")
    }
}
