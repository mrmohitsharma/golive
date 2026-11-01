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

    // Camera controls (brightness, zoom, focus, lock, torch). Kept so they come back after a
    // camera switch or a new initialize.
    private struct Controls {
        var zoom: CGFloat = 1
        var ev: Float = 0
        var autoFocus = true
        var focusNear: Float = 0
        var locked = false
        var torch = false
    }
    private var controls = Controls()
    private var device: AVCaptureDevice?
    /// The device zoom factor that shows as "1x" (the main lens). On a virtual multi-lens camera
    /// factor 1 is the ultra-wide lens and the main lens starts at the first switch-over factor.
    private var zoomBase: CGFloat = 1
    private let meter = AudioMeter()

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
        let portrait = args["portrait"] as? Bool ?? false
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
        await mixer.addOutput(meter)
        try? await mixer.setFrameRate(Float64(fps))
        try? await mixer.configuration(video: 0) { unit in
            try unit.setFrameRate(Float64(fps))
        }
        await updateOrientation()

        var video = await stream.videoSettings
        // Portrait: the phone held upright sends vertical 9:16 video.
        video.videoSize = portrait ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
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
        reapply()
        return portrait
            ? ["width": height, "height": width, "fps": fps, "portrait": true]
            : ["width": width, "height": height, "fps": fps, "portrait": false]
    }

    private func attachCamera(_ mixer: MediaMixer) async throws {
        // Rear: a multi-lens camera when the phone has one, so zoom can go to 0.5x (ultra-wide)
        // and iOS changes lens by itself without a pause.
        let types: [AVCaptureDevice.DeviceType] = position == .back
            ? [.builtInTripleCamera, .builtInDualWideCamera, .builtInWideAngleCamera]
            : [.builtInWideAngleCamera]
        var found: AVCaptureDevice?
        for type in types where found == nil {
            found = AVCaptureDevice.default(type, for: .video, position: position)
        }
        guard let device = found else { throw EngineError.message("No \(position == .front ? "front" : "rear") camera on this device.") }
        let mirrored = position == .front
        try await mixer.attachVideo(device) { unit in
            unit.isVideoMirrored = mirrored
        }
        self.device = device
        zoomBase = CGFloat(device.virtualDeviceSwitchOverVideoZoomFactors.first?.doubleValue ?? 1)
    }

    // MARK: camera controls

    private func configure(_ change: (AVCaptureDevice) throws -> Void) throws {
        guard let device else { throw EngineError.message("Camera is not open.") }
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        try change(device)
    }

    func caps() -> [String: Any] {
        guard let d = device else { return [:] }
        let maxZoom = min(d.maxAvailableVideoZoomFactor, zoomBase * 10)
        return [
            "zoomMin": Double(d.minAvailableVideoZoomFactor / zoomBase),
            "zoomMax": Double(maxZoom / zoomBase),
            "evMin": Double(max(d.minExposureTargetBias, -3)),
            "evMax": Double(min(d.maxExposureTargetBias, 3)),
            "evStep": 0.1,
            "torch": d.hasTorch,
            "manualFocus": d.isLockingFocusWithCustomLensPositionSupported,
            "focusPoint": d.isFocusPointOfInterestSupported,
            "lensSwitch": false,
        ]
    }

    func setZoom(_ display: CGFloat) throws -> Double {
        controls.zoom = display
        var applied = display
        try configure { d in
            let factor = min(max(display * zoomBase, d.minAvailableVideoZoomFactor), min(d.maxAvailableVideoZoomFactor, zoomBase * 10))
            // Big jumps (the 0.5x / 2x buttons) glide; dragging the arc follows the finger.
            if abs(factor - d.videoZoomFactor) > zoomBase * 0.6 {
                d.ramp(toVideoZoomFactor: factor, withRate: 6)
            } else {
                d.cancelVideoZoomRamp()
                d.videoZoomFactor = factor
            }
            applied = factor / zoomBase
        }
        return Double(applied)
    }

    func setExposureBias(_ ev: Float) throws {
        controls.ev = ev
        try configure { d in
            d.setExposureTargetBias(min(max(ev, d.minExposureTargetBias), d.maxExposureTargetBias), completionHandler: nil)
        }
    }

    /// A point of the preview (0..1 as seen on screen) in the camera's own coordinates
    /// (landscape, home button on the right).
    private func devicePoint(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        let px = position == .front ? 1 - x : x
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        switch scene?.interfaceOrientation {
        case .landscapeRight: return CGPoint(x: px, y: y)
        case .landscapeLeft: return CGPoint(x: 1 - px, y: 1 - y)
        case .portraitUpsideDown: return CGPoint(x: 1 - y, y: px)
        default: return CGPoint(x: y, y: 1 - px)
        }
    }

    private func aim(at point: CGPoint, focus: AVCaptureDevice.FocusMode) throws {
        try configure { d in
            if d.isFocusPointOfInterestSupported, d.isFocusModeSupported(focus) {
                d.focusPointOfInterest = point
                d.focusMode = focus
            }
            if d.isExposurePointOfInterestSupported, d.isExposureModeSupported(.continuousAutoExposure) {
                d.exposurePointOfInterest = point
                d.exposureMode = .continuousAutoExposure
            }
        }
    }

    func focusAt(_ x: CGFloat, _ y: CGFloat) throws {
        if controls.locked { try setAeAfLock(false, x: nil, y: nil) }
        try aim(at: devicePoint(x, y), focus: controls.autoFocus ? .autoFocus : .locked)
        // Back to continuous focus a few seconds later (unless manual or locked).
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if self.controls.autoFocus, !self.controls.locked {
                try? self.configure { d in
                    if d.isFocusModeSupported(.continuousAutoFocus) { d.focusMode = .continuousAutoFocus }
                }
            }
        }
    }

    func setAutoFocus(_ on: Bool) throws {
        controls.autoFocus = on
        if on {
            try configure { d in
                if d.isFocusModeSupported(.continuousAutoFocus) { d.focusMode = .continuousAutoFocus }
            }
        } else {
            try setFocusDistance(controls.focusNear)
        }
    }

    /// Manual focus: near 0 = far away, 1 = closest.
    func setFocusDistance(_ near: Float) throws {
        controls.focusNear = min(max(near, 0), 1)
        controls.autoFocus = false
        let lens = 1 - controls.focusNear
        try configure { d in
            if d.isLockingFocusWithCustomLensPositionSupported {
                d.setFocusModeLocked(lensPosition: lens, completionHandler: nil)
            }
        }
    }

    func setAeAfLock(_ lock: Bool, x: CGFloat?, y: CGFloat?) throws {
        controls.locked = lock
        if lock {
            if let x, let y {
                try aim(at: devicePoint(x, y), focus: controls.autoFocus ? .autoFocus : .locked)
            }
            // Let focus and exposure settle on the point, then hold them.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 600_000_000)
                guard self.controls.locked else { return }
                try? self.configure { d in
                    if d.isFocusModeSupported(.locked) { d.focusMode = .locked }
                    if d.isExposureModeSupported(.locked) { d.exposureMode = .locked }
                }
            }
        } else {
            try configure { d in
                if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
            }
            if controls.autoFocus { try setAutoFocus(true) } else { try setFocusDistance(controls.focusNear) }
        }
    }

    func setTorch(_ on: Bool) throws {
        guard let d = device, d.hasTorch, d.isTorchAvailable else {
            controls.torch = false
            if on { throw EngineError.message("This camera has no light.") }
            return
        }
        controls.torch = on
        try configure { d in d.torchMode = on ? .on : .off }
    }

    /// Puts the operator's settings back on the (new) camera.
    private func reapply() {
        let c = controls
        _ = try? setZoom(c.zoom)
        if c.ev != 0 { try? setExposureBias(c.ev) }
        if !c.autoFocus { try? setFocusDistance(c.focusNear) }
        if c.torch { try? setTorch(true) }
        if c.locked { try? setAeAfLock(true, x: nil, y: nil) }
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
        // Front <-> back starts from 1x with no light; brightness and focus mode carry over.
        controls.zoom = 1
        controls.torch = false
        controls.locked = false
        reapply()
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
        controls = Controls()
        device = nil
        if let mixer {
            await mixer.removeOutput(meter)
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

/// Microphone level for the meter on the camera screen: the loudest sample, falling back
/// slowly, about 10 times a second.
final class AudioMeter: MediaMixerOutput, @unchecked Sendable {
    let videoTrackId: UInt8? = nil
    let audioTrackId: UInt8? = UInt8.max
    private let lock = NSLock()
    private var level: Float = 0
    private var last = Date.distantPast

    func selectTrack(_ id: UInt8?, mediaType: CMFormatDescription.MediaType) async {}

    func mixer(_ mixer: MediaMixer, didOutput sampleBuffer: CMSampleBuffer) {}

    func mixer(_ mixer: MediaMixer, didOutput buffer: AVAudioPCMBuffer, when: AVAudioTime) {
        let frames = Int(buffer.frameLength)
        var peak: Float = 0
        if let f = buffer.floatChannelData {
            for i in 0..<frames { peak = max(peak, abs(f[0][i])) }
        } else if let s = buffer.int16ChannelData {
            for i in 0..<frames { peak = max(peak, abs(Float(s[0][i]) / 32768)) }
        }
        lock.lock()
        level = max(level * 0.8, min(peak, 1))
        let now = Date()
        let send = now.timeIntervalSince(last) >= 0.1
        if send { last = now }
        let value = level
        lock.unlock()
        if send {
            Task { @MainActor in
                StreamEngine.shared.onEvent?(["type": "audioLevel", "level": Double(value)])
            }
        }
    }
}

enum EngineError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let m) = self { return m }
        return nil
    }
}
