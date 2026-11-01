import Flutter
import HaishinKit
import UIKit

public class CgStreamerPlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private var sink: FlutterEventSink?

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = CgStreamerPlugin()
        let methods = FlutterMethodChannel(name: "cg_streamer", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: methods)
        let events = FlutterEventChannel(name: "cg_streamer/events", binaryMessenger: registrar.messenger())
        events.setStreamHandler(instance)
        registrar.register(PreviewFactory(), withId: "cg_streamer/preview")
        Task { @MainActor in
            StreamEngine.shared.onEvent = { [weak instance] event in
                instance?.sink?(event)
            }
        }
    }

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        sink = events
        return nil
    }

    public func onCancel(withArguments arguments: Any?) -> FlutterError? {
        sink = nil
        return nil
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        let method = call.method
        Task { @MainActor in
            let engine = StreamEngine.shared
            do {
                switch method {
                case "requestPermissions":
                    result(await StreamEngine.requestPermissions())
                case "initialize":
                    result(try await engine.initialize(args))
                case "start":
                    guard let url = args["url"] as? String else {
                        return result(FlutterError(code: "bad_args", message: "url is required", details: nil))
                    }
                    try await engine.start(url)
                    result(nil)
                case "stop":
                    await engine.stop()
                    result(nil)
                case "switchCamera":
                    try await engine.switchCamera()
                    result(nil)
                case "cameraCaps":
                    result(engine.caps())
                case "setZoom":
                    result(try engine.setZoom(Self.cg(args["zoom"]) ?? 1))
                case "setExposureBias":
                    try engine.setExposureBias(Float(Self.cg(args["ev"]) ?? 0))
                    result(nil)
                case "focusAt":
                    try engine.focusAt(Self.cg(args["x"]) ?? 0.5, Self.cg(args["y"]) ?? 0.5)
                    result(nil)
                case "setAutoFocus":
                    try engine.setAutoFocus(args["on"] as? Bool ?? true)
                    result(nil)
                case "setFocusDistance":
                    try engine.setFocusDistance(Float(Self.cg(args["near"]) ?? 0))
                    result(nil)
                case "setAeAfLock":
                    try engine.setAeAfLock(args["lock"] as? Bool ?? false, x: Self.cg(args["x"]), y: Self.cg(args["y"]))
                    result(nil)
                case "setTorch":
                    try engine.setTorch(args["on"] as? Bool ?? false)
                    result(nil)
                case "setVideoBitrate":
                    try await engine.setVideoBitrate(args["bitrate"] as? Int ?? 2_500_000)
                    result(nil)
                case "dispose":
                    await engine.dispose()
                    result(nil)
                case "keepScreenOn":
                    UIApplication.shared.isIdleTimerDisabled = args["on"] as? Bool ?? false
                    result(nil)
                case "deviceStatus":
                    result(engine.deviceStatus())
                case "deviceId":
                    result(engine.deviceId())
                default:
                    result(FlutterMethodNotImplemented)
                }
            } catch {
                result(FlutterError(code: "native_error", message: StreamEngine.describe(error), details: nil))
            }
        }
    }
}

extension CgStreamerPlugin {
    /// Dart numbers arrive as Double or Int (NSNumber); null stays nil.
    static func cg(_ v: Any?) -> CGFloat? {
        (v as? NSNumber).map { CGFloat($0.doubleValue) }
    }
}

final class PreviewFactory: NSObject, FlutterPlatformViewFactory {
    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        PreviewPlatformView(frame: frame)
    }

    func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
        FlutterStandardMessageCodec.sharedInstance()
    }
}

/// Native Metal preview of the camera (HaishinKit MTHKView). Not a WebView.
final class PreviewPlatformView: NSObject, FlutterPlatformView {
    private let preview: MTHKView

    init(frame: CGRect) {
        preview = MTHKView(frame: frame)
        preview.videoGravity = .resizeAspect
        preview.backgroundColor = .black
        super.init()
        let view = preview
        Task { @MainActor in
            await StreamEngine.shared.attachPreview(view)
        }
    }

    func view() -> UIView {
        preview
    }

    deinit {
        let view = preview
        Task { @MainActor in
            await StreamEngine.shared.detachPreview(view)
        }
    }
}
