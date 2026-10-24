// SRT camera publishing for CoGolfer Live.
//
// One Dart API, two native implementations:
//  * Android: RootEncoder `SrtStream` (Camera2 + MediaCodec H.264/AAC), foreground service.
//  * iOS/iPadOS: HaishinKit `SRTConnection`/`SRTStream` (AVFoundation + VideoToolbox).

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

enum CameraFacing { back, front }

class StreamConfig {
  const StreamConfig({
    this.width = 1280,
    this.height = 720,
    this.fps = 30,
    this.videoBitrateKbps = 2500,
    this.audioBitrateKbps = 128,
    this.facing = CameraFacing.back,
    this.keyframeIntervalSec = 2,
  });

  final int width;
  final int height;
  final int fps;
  final int videoBitrateKbps;
  final int audioBitrateKbps;
  final CameraFacing facing;
  final int keyframeIntervalSec;

  Map<String, Object> toMap() => {
        'width': width,
        'height': height,
        'fps': fps,
        'videoBitrate': videoBitrateKbps * 1000,
        'audioBitrate': audioBitrateKbps * 1000,
        'facing': facing.name,
        'keyframeInterval': keyframeIntervalSec,
      };

  String get label => '${height}p$fps · ${(videoBitrateKbps / 1000).toStringAsFixed(1)} Mbps';
}

/// Native publisher states, identical on both platforms.
enum PublisherState {
  /// Camera ready, not publishing.
  idle,
  connecting,

  /// SRT handshake accepted by the ingest server and media is flowing.
  live,

  /// The SRT connection dropped (network change, server restart, ...).
  disconnected,

  /// The OS suspended the camera (app backgrounded on iOS, another app took the camera,
  /// a phone call, iPad Split View...). Media is not flowing.
  interrupted,

  /// The camera is available again after an interruption.
  resumed,
  error,
  stopped,
}

class PublisherEvent {
  PublisherEvent(this.state, {this.message});
  final PublisherState state;
  final String? message;

  @override
  String toString() => 'PublisherEvent($state${message != null ? ', $message' : ''})';
}

class DeviceStatus {
  const DeviceStatus({
    required this.platform,
    required this.model,
    this.battery,
    this.charging,
    this.thermal,
  });

  final String platform; // android | ios
  final String model;
  final int? battery; // 0-100
  final bool? charging;
  final String? thermal; // nominal | fair | serious | critical | unknown

  factory DeviceStatus.fromMap(Map<Object?, Object?> m) => DeviceStatus(
        platform: (m['platform'] as String?) ?? 'other',
        model: (m['model'] as String?) ?? 'unknown',
        battery: (m['battery'] as num?)?.round(),
        charging: m['charging'] as bool?,
        thermal: m['thermal'] as String?,
      );
}

class CgStreamer {
  CgStreamer._();

  static const MethodChannel _channel = MethodChannel('cg_streamer');
  static const EventChannel _events = EventChannel('cg_streamer/events');

  static final StreamController<PublisherEvent> _stateCtl = StreamController.broadcast();
  static final StreamController<int> _bitrateCtl = StreamController.broadcast();
  static StreamSubscription<dynamic>? _sub;

  static void _ensureListening() {
    _sub ??= _events.receiveBroadcastStream().listen(
      (dynamic e) {
        if (e is! Map) return;
        switch (e['type']) {
          case 'state':
            final name = e['state'] as String?;
            final state = PublisherState.values.firstWhere(
              (s) => s.name == name,
              orElse: () => PublisherState.error,
            );
            _stateCtl.add(PublisherEvent(state, message: e['message'] as String?));
          case 'bitrate':
            _bitrateCtl.add(((e['bps'] as num?) ?? 0) ~/ 1000);
        }
      },
      onError: (Object err) => _stateCtl.add(PublisherEvent(PublisherState.error, message: '$err')),
    );
  }

  /// Publisher state changes reported by the native SDK.
  static Stream<PublisherEvent> get states {
    _ensureListening();
    return _stateCtl.stream;
  }

  /// Measured upload bitrate in kbps (Android: RootEncoder; iOS: SRT socket stats), about once per second.
  static Stream<int> get uploadKbps {
    _ensureListening();
    return _bitrateCtl.stream;
  }

  /// Asks for camera + microphone. Returns true only if both are granted.
  static Future<bool> requestPermissions() async =>
      (await _channel.invokeMethod<bool>('requestPermissions')) ?? false;

  /// Opens the camera and prepares encoders. Call before showing [CgCameraPreview].
  /// Returns the configuration the device actually accepted.
  static Future<Map<String, Object?>> initialize(StreamConfig config) async {
    _ensureListening();
    final r = await _channel.invokeMapMethod<String, Object?>('initialize', config.toMap());
    return r ?? const {};
  }

  /// Starts publishing to an SRT URL (srt://host:port?streamid=...).
  /// On Android this also starts a foreground service with a persistent notification.
  static Future<void> start(String srtUrl) => _channel.invokeMethod('start', {'url': srtUrl});

  static Future<void> stop() => _channel.invokeMethod('stop');

  static Future<void> switchCamera() => _channel.invokeMethod('switchCamera');

  /// Live bitrate change without reconnecting.
  static Future<void> setVideoBitrate(int kbps) => _channel.invokeMethod('setVideoBitrate', {'bitrate': kbps * 1000});

  /// Releases the camera and encoders.
  static Future<void> dispose() => _channel.invokeMethod('dispose');

  /// Keeps the screen awake (Android FLAG_KEEP_SCREEN_ON / iOS isIdleTimerDisabled).
  static Future<void> setKeepScreenOn(bool on) => _channel.invokeMethod('keepScreenOn', {'on': on});

  static Future<DeviceStatus> deviceStatus() async {
    final m = await _channel.invokeMapMethod<Object?, Object?>('deviceStatus');
    return DeviceStatus.fromMap(m ?? const {});
  }

  /// Stable per-install identifier used to re-attach this phone to its camera slot.
  static Future<String> deviceId() async => (await _channel.invokeMethod<String>('deviceId')) ?? 'unknown-device';
}

/// Native camera preview. Not a WebView: an Android SurfaceView rendered by RootEncoder's
/// OpenGL pipeline, or an iOS Metal view (HaishinKit MTHKView).
class CgCameraPreview extends StatelessWidget {
  const CgCameraPreview({super.key});

  static const _viewType = 'cg_streamer/preview';

  @override
  Widget build(BuildContext context) {
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        // Hybrid composition keeps the SurfaceView in sync with Flutter overlays.
        return PlatformViewLink(
          viewType: _viewType,
          surfaceFactory: (context, controller) => AndroidViewSurface(
            controller: controller as AndroidViewController,
            gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
            hitTestBehavior: PlatformViewHitTestBehavior.opaque,
          ),
          onCreatePlatformView: (params) {
            return PlatformViewsService.initExpensiveAndroidView(
              id: params.id,
              viewType: _viewType,
              layoutDirection: TextDirection.ltr,
              creationParamsCodec: const StandardMessageCodec(),
            )
              ..addOnPlatformViewCreatedListener(params.onPlatformViewCreated)
              ..create();
          },
        );
      case TargetPlatform.iOS:
        return const UiKitView(viewType: _viewType, creationParamsCodec: StandardMessageCodec());
      default:
        return const Center(child: Text('Camera streaming is supported on Android and iOS only.'));
    }
  }
}
