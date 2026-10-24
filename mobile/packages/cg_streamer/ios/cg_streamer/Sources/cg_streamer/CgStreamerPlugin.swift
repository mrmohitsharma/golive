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
