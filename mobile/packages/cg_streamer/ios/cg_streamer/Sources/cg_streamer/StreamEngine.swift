import AVFoundation
import HaishinKit
import SRTHaishinKit
import UIKit
import VideoToolbox

/// Owns the HaishinKit pipeline for the app:
///   AVCaptureSession (MediaMixer) -> VideoToolbox H.264 + AAC -> MPEG-TS -> SRT caller -> MediaMTX.
///
/// iOS background rule (verified against Apple's AVFoundation behaviour): an app cannot capture
/// from the camera while it is in the background or the device is locked. AVCaptureSession is
/// interrupted with `videoDeviceNotAvailableInBackground`. This engine does NOT pretend otherwise:
/// it reports `interrupted` so the app can warn the operator and the Director sees the feed
/// as paused. Capture resumes when the app returns to the foreground.
@MainActor
final class StreamEngine {
    static let shared = StreamEngine()

    var onEvent: (([String: Any]) -> Void)?

    private var mixer: MediaMixer?
    private var connection: SRTConnection?
    private var stream: SRTStream?
    private var previews: [MTHKView] = []
    private var position: AVCaptureDevice.Position = .back
    private var publishing = false
    private var monitorTask: Task<Void, Never>?
    private var interruptTask: Task<Void, Never>?
    private var lastBytes: UInt64 = 0
    private var lastSample = Date()
    private var observers: [NSObjectProtocol] = []

    private init() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                StreamEngine.shared.emitState("interrupted", message: "App moved to the background. iOS pauses the camera until you return to the app.")
            }
        })
        observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                StreamEngine.shared.emitState("resumed")
            }
        })
        observers.append(nc.addObserver(forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in
                await StreamEngine.shared.updateOrientation()
            }
        })
    }

    // MARK: events

    func emitState(_ state: String, message: String? = nil) {
        var e: [String: Any] = ["type": "state", "state": state]
        if let message { e["message"] = message }
        onEvent?(e)
    }

    // MARK: permissions

    static func requestPermissions() async -> Bool {
        let video = await AVCaptureDevice.requestAccess(for: .video)
        let audio = await AVCaptureDevice.requestAccess(for: .audio)
        return video && audio
    }

    // MARK: setup

    func initialize(_ args: [String: Any]) async throws -> [String: Any] {
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
              AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw EngineError.message("Camera and microphone permission are required. Enable them in Settings.")
        }
        if publishing { throw EngineError.message("Stop streaming before changing camera settings.") }

        let width = args["width"] as? Int ?? 1280
        let height = args["height"] as? Int ?? 720
        let fps = args["fps"] as? Int ?? 30
        let videoBitrate = args["videoBitrate"] as? Int ?? 2_500_000
        let audioBitrate = args["audioBitrate"] as? Int ?? 128_000
        let keyframe = args["keyframeInterval"] as? Int ?? 2
        position = (args["facing"] as? String) == "front" ? .front : .back

        let mixer = self.mixer ?? MediaMixer()
        let connection = self.connection ?? SRTConnection()
        let stream = self.stream ?? SRTStream(connection: connection)
        self.mixer = mixer
        self.connection = connection
        self.stream = stream

        await mixer.setSessionPreset(height >= 1080 ? .hd1920x1080 : .hd1280x720)
        // iPad: keep the camera running in Split View / Slide Over where the OS allows it.
        if #available(iOS 16.0, *) {
            await mixer.configuration { session in
                if session.isMultitaskingCameraAccessSupported {
                    session.isMultitaskingCameraAccessEnabled = true
                }
            }
        }
        try await attachCamera(mixer)
        try await mixer.attachAudio(AVCaptureDevice.default(for: .audio))
        try? await mixer.setFrameRate(Float64(fps))
        try? await mixer.configuration(video: 0) { unit in
            try unit.setFrameRate(Float64(fps))
        }
        await updateOrientation()

        var video = await stream.videoSettings
        video.videoSize = CGSize(width: width, height: height)
        video.bitRate = videoBitrate
        video.profileLevel = kVTProfileLevel_H264_Main_AutoLevel as String
        video.maxKeyFrameIntervalDuration = Int32(keyframe)
        // No B-frames: keeps WebRTC previews and OBS decoding simple and low latency.
        video.allowFrameReordering = false
        video.expectedFrameRate = Double(fps)
        try await stream.setVideoSettings(video)

        var audio = await stream.audioSettings
        audio.bitRate = audioBitrate
        try await stream.setAudioSettings(audio)

        await mixer.addOutput(stream)
        for view in previews {
            await mixer.addOutput(view)
        }
        await mixer.startRunning()

        interruptTask?.cancel()
        interruptTask = Task { @MainActor in
            for await interrupted in await mixer.isInterputted {
                StreamEngine.shared.emitState(
                    interrupted ? "interrupted" : "resumed",
                    message: interrupted ? "iOS paused the camera (background, call, or another app using it)." : nil
                )
            }
        }
        return ["width": width, "height": height, "fps": fps]
    }

    private func attachCamera(_ mixer: MediaMixer) async throws {
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
        guard let device else { throw EngineError.message("No \(position == .front ? "front" : "rear") camera on this device.") }
        let mirrored = position == .front
        try await mixer.attachVideo(device) { unit in
            unit.isVideoMirrored = mirrored
        }
    }

    func updateOrientation() async {
        guard let mixer else { return }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let orientation: AVCaptureVideoOrientation
        switch scene?.interfaceOrientation {
        case .landscapeLeft: orientation = .landscapeLeft
        case .landscapeRight: orientation = .landscapeRight
        case .portraitUpsideDown: orientation = .portraitUpsideDown
        default: orientation = .portrait
        }
        await mixer.setVideoOrientation(orientation)
    }

    // MARK: preview

    func attachPreview(_ view: MTHKView) async {
        if !previews.contains(where: { $0 === view }) { previews.append(view) }
        if let mixer { await mixer.addOutput(view) }
    }

    func detachPreview(_ view: MTHKView) async {
        previews.removeAll { $0 === view }
        if let mixer { await mixer.removeOutput(view) }
    }

    // MARK: publish

    func start(_ urlString: String) async throws {
        guard let connection, let stream else { throw EngineError.message("Call initialize first.") }
        guard let url = URL(string: urlString) else { throw EngineError.message("Invalid SRT URL.") }
        monitorTask?.cancel()
        let wasConnected = await connection.connected
        if wasConnected { await connection.close() }
        publishing = true
        emitState("connecting")
        do {
            try await connection.connect(url)
            await stream.publish()
            lastBytes = 0
            lastSample = Date()
            emitState("live")
            startMonitor()
        } catch {
            publishing = false
            emitState("disconnected", message: Self.describe(error))
        }
    }

    private func startMonitor() {
        monitorTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                guard let connection = self.connection else { return }
                let stillConnected = await connection.connected
                if !stillConnected {
                    if self.publishing {
                        self.publishing = false
                        self.emitState("disconnected", message: "Connection to the ingest server was lost.")
                    }
                    return
                }
                let perfData = await connection.performanceData
                if let perf = perfData {
                    let now = Date()
                    let elapsed = now.timeIntervalSince(self.lastSample)
                    if self.lastBytes > 0, elapsed > 0, perf.byteSentTotal >= self.lastBytes {
                        let bps = Double(perf.byteSentTotal - self.lastBytes) * 8.0 / elapsed
                        self.onEvent?(["type": "bitrate", "bps": Int(bps)])
                    }
                    self.lastBytes = perf.byteSentTotal
                    self.lastSample = now
                }
            }
        }
    }

    func stop() async {
        publishing = false
        monitorTask?.cancel()
        monitorTask = nil
        if let stream { await stream.close() }
        if let connection { await connection.close() }
        emitState("stopped")
    }

    func switchCamera() async throws {
        guard let mixer else { throw EngineError.message("Camera is not open.") }
        position = position == .back ? .front : .back
        try await attachCamera(mixer)
        await updateOrientation()
    }

    func setVideoBitrate(_ bps: Int) async throws {
        guard let stream else { return }
        var video = await stream.videoSettings
        video.bitRate = bps
        try await stream.setVideoSettings(video)
    }

    func dispose() async {
        await stop()
        interruptTask?.cancel()
        interruptTask = nil
        if let mixer {
            await mixer.stopRunning()
            try? await mixer.attachAudio(nil)
            try? await mixer.attachVideo(nil)
            if let stream { await mixer.removeOutput(stream) }
        }
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // MARK: device

    func deviceStatus() -> [String: Any] {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        var status: [String: Any] = ["platform": "ios", "model": Self.modelIdentifier()]
        if device.batteryLevel >= 0 { status["battery"] = Int((device.batteryLevel * 100).rounded()) }
        status["charging"] = device.batteryState == .charging || device.batteryState == .full
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: status["thermal"] = "nominal"
        case .fair: status["thermal"] = "fair"
        case .serious: status["thermal"] = "serious"
        case .critical: status["thermal"] = "critical"
        @unknown default: status["thermal"] = "unknown"
        }
        return status
    }

    func deviceId() -> String {
        let key = "cg_streamer.device_id"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    private static func modelIdentifier() -> String {
        var info = utsname()
        uname(&info)
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        return "\(UIDevice.current.model) (\(machine))"
    }

    static func describe(_ error: Error) -> String {
        if let e = error as? SRTConnection.Error {
            switch e {
            case .failedToConnect(let reason): return "Ingest server refused the connection (\(reason))."
            case .unsupportedUri: return "Invalid SRT URL."
            case .invalidState: return "Could not reach the ingest server."
            }
        }
        if let e = error as? EngineError, case .message(let m) = e { return m }
        return error.localizedDescription
    }
}

enum EngineError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let m) = self { return m }
        return nil
    }
}
