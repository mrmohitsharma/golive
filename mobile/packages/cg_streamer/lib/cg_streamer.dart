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
    this.portrait = false,
  });

  final int width;
  final int height;
  final int fps;
  final int videoBitrateKbps;
  final int audioBitrateKbps;
  final CameraFacing facing;
  final int keyframeIntervalSec;

  /// Vertical 9:16 video (the phone held upright). The encoder then sends height x width.
  final bool portrait;

  StreamConfig copyWith({bool? portrait, CameraFacing? facing}) => StreamConfig(
        width: width,
        height: height,
        fps: fps,
        videoBitrateKbps: videoBitrateKbps,
        audioBitrateKbps: audioBitrateKbps,
        facing: facing ?? this.facing,
        keyframeIntervalSec: keyframeIntervalSec,
        portrait: portrait ?? this.portrait,
      );

  Map<String, Object> toMap() => {
        'width': width,
        'height': height,
        'fps': fps,
        'videoBitrate': videoBitrateKbps * 1000,
        'audioBitrate': audioBitrateKbps * 1000,
        'facing': facing.name,
        'keyframeInterval': keyframeIntervalSec,
        'portrait': portrait,
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

/// What the open camera can do. Zoom is in "display" units: 1.0 = the main lens, 0.5 = the
/// ultra-wide lens where the phone has one.
class CameraCaps {
  const CameraCaps({
    this.zoomMin = 1,
    this.zoomMax = 1,
    this.evMin = 0,
    this.evMax = 0,
    this.evStep = 1,
    this.torch = false,
    this.manualFocus = false,
    this.focusPoint = false,
    this.lensSwitch = false,
  });

  final double zoomMin;
  final double zoomMax;

  /// Exposure (brightness) range in EV stops.
  final double evMin;
  final double evMax;
  final double evStep;
  final bool torch;
  final bool manualFocus;

  /// Tap to focus / meter at a point.
  final bool focusPoint;

  /// Going below 1x changes to another camera: the picture freezes for about a second.
  final bool lensSwitch;

  factory CameraCaps.fromMap(Map<Object?, Object?> m) {
    double d(String k, double def) => (m[k] as num?)?.toDouble() ?? def;
    final zMin = d('zoomMin', 1), eMin = d('evMin', 0), step = d('evStep', 1);
    return CameraCaps(
      zoomMin: zMin,
      zoomMax: d('zoomMax', 1) < zMin ? zMin : d('zoomMax', 1),
      evMin: eMin,
      evMax: d('evMax', 0) < eMin ? eMin : d('evMax', 0),
      evStep: step > 0 ? step : 0.1,
      torch: m['torch'] == true,
      manualFocus: m['manualFocus'] == true,
      focusPoint: m['focusPoint'] == true,
      lensSwitch: m['lensSwitch'] == true,
    );
  }
}

class CgStreamer {
  CgStreamer._();

  static const MethodChannel _channel = MethodChannel('cg_streamer');
  static const EventChannel _events = EventChannel('cg_streamer/events');

  static final StreamController<PublisherEvent> _stateCtl = StreamController.broadcast();
  static final StreamController<int> _bitrateCtl = StreamController.broadcast();
  static final StreamController<double> _audioCtl = StreamController.broadcast();
  static final StreamController<bool> _lensCtl = StreamController.broadcast();
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
          case 'audioLevel':
            _audioCtl.add(((e['level'] as num?) ?? 0).toDouble().clamp(0, 1));
          case 'lens':
            _lensCtl.add(e['switching'] == true);
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

  /// Microphone level 0..1 (peak, smoothed), about 10 times a second.
  static Stream<double> get audioLevel {
    _ensureListening();
    return _audioCtl.stream;
  }

  /// true while the phone changes lens (ultra-wide <-> main), false when the picture is back.
  static Stream<bool> get lensSwitching {
    _ensureListening();
    return _lensCtl.stream;
  }

  /// What the open camera supports (changes after switchCamera / initialize).
  static Future<CameraCaps> cameraCaps() async =>
      CameraCaps.fromMap(await _channel.invokeMapMethod<Object?, Object?>('cameraCaps') ?? const {});

  /// Zoom in display units (see [CameraCaps]). Returns the zoom actually applied.
  static Future<double> setZoom(double zoom) async =>
      ((await _channel.invokeMethod<num>('setZoom', {'zoom': zoom})) ?? zoom).toDouble();

  /// Brightness: exposure compensation in EV stops (0 = auto).
  static Future<void> setExposureBias(double ev) => _channel.invokeMethod('setExposureBias', {'ev': ev});

  /// Focuses and meters exposure at a point of the preview (x, y from 0 to 1, as seen on screen).
  static Future<void> focusAt(double x, double y) => _channel.invokeMethod('focusAt', {'x': x, 'y': y});

  /// Continuous autofocus (true) or manual focus (false; then use [setFocusDistance]).
  static Future<void> setAutoFocus(bool on) => _channel.invokeMethod('setAutoFocus', {'on': on});

  /// Manual focus: 0 = far (infinity), 1 = as close as the lens goes.
  static Future<void> setFocusDistance(double near) => _channel.invokeMethod('setFocusDistance', {'near': near});

  /// Holds focus and exposure where they are now (or at x, y if given) until unlocked.
  static Future<void> setAeAfLock(bool lock, {double? x, double? y}) =>
      _channel.invokeMethod('setAeAfLock', {'lock': lock, 'x': x, 'y': y});

  static Future<void> setTorch(bool on) => _channel.invokeMethod('setTorch', {'on': on});

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
