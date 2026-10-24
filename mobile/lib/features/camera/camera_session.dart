import 'dart:async';

import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';

enum CameraPhase { starting, ready, connecting, live, reconnecting, paused, error }

/// Drives one phone acting as a tournament camera.
///
/// Reconnection policy (same on Android and iOS): while the operator wants to be live,
/// any SRT drop is retried with exponential backoff (1 s → 8 s, jittered) forever, and
/// the publish key is re-fetched if the server refused it. Phone telemetry is pushed to
/// the control room every 2 s and immediately on state changes.
class CameraSession extends ChangeNotifier with WidgetsBindingObserver {
  CameraSession({required this.session, required this.camera, required this.target, required this.config});

  final Session session;
  CameraInfo camera;
  PublishTarget target;
  final StreamConfig config;

  late final ApiClient _api = session.api();
  RealtimeLink? link;

  CameraPhase phase = CameraPhase.starting;
  String? message;
  bool wantLive = false;
  int reconnectAttempts = 0;
  DateTime? retryAt;
  DateTime? liveSince;
  int uploadKbps = 0;
  DeviceStatus? device;
  bool onAir = false;
  bool inPreview = false;
  bool appInBackground = false;
  bool removedByDirector = false;
  Map<String, Object?> actual = const {};

  bool _publisherConnected = false;
  bool _refreshKeyBeforeRetry = false;
  final _backoff = Backoff(base: const Duration(seconds: 1), max: const Duration(seconds: 8));
  Timer? _retryTimer;
  Timer? _telemetryTimer;
  Timer? _deviceTimer;
  Timer? _tick;
  StreamSubscription<PublisherEvent>? _stateSub;
  StreamSubscription<int>? _kbpsSub;
  StreamSubscription<Map<String, dynamic>>? _msgSub;
  bool _disposed = false;

  Duration get liveFor => liveSince == null ? Duration.zero : DateTime.now().difference(liveSince!);

  Future<void> open() async {
    WidgetsBinding.instance.addObserver(this);
    _stateSub = CgStreamer.states.listen(_onPublisher);
    _kbpsSub = CgStreamer.uploadKbps.listen((k) {
      uploadKbps = k;
      _notify();
    });

    final l = RealtimeLink(
      serverUrl: session.serverUrl,
      token: session.token!,
      onOpenMessages: () => [
        {'type': 'camera.join', 'cameraId': camera.id},
      ],
    );
    link = l;
    _msgSub = l.messages.listen(_onServerMessage);
    l.state.addListener(_notify);
    l.connect();

    try {
      actual = await CgStreamer.initialize(config);
      phase = CameraPhase.ready;
    } on PlatformException catch (e) {
      phase = CameraPhase.error;
      message = e.message ?? 'The camera could not be opened.';
    }
    await CgStreamer.setKeepScreenOn(true);
    await _refreshDevice();

    _telemetryTimer = Timer.periodic(const Duration(seconds: 2), (_) => _sendTelemetry());
    _deviceTimer = Timer.periodic(const Duration(seconds: 30), (_) => _refreshDevice());
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (phase == CameraPhase.live || retryAt != null) _notify();
    });
    _notify();
  }

  Future<void> _refreshDevice() async {
    try {
      device = await CgStreamer.deviceStatus();
      _notify();
    } on PlatformException {
      // not critical
    }
  }

  // ---------------------------------------------------------------- operator actions
  Future<void> goLive() async {
    if (phase == CameraPhase.error || phase == CameraPhase.starting) return;
    wantLive = true;
    reconnectAttempts = 0;
    _backoff.reset();
    await _startPublish();
  }

  Future<void> stopLive() async {
    wantLive = false;
    _retryTimer?.cancel();
    retryAt = null;
    reconnectAttempts = 0;
    try {
      await CgStreamer.stop();
    } on PlatformException {
      // already stopped
    }
    _publisherConnected = false;
    liveSince = null;
    uploadKbps = 0;
    phase = CameraPhase.ready;
    message = null;
    _sendTelemetry();
    _notify();
  }

  Future<void> switchCamera() async {
    try {
      await CgStreamer.switchCamera();
    } on PlatformException catch (e) {
      message = e.message;
      _notify();
    }
  }

  // ---------------------------------------------------------------- publishing
  Future<void> _startPublish() async {
    _retryTimer?.cancel();
    retryAt = null;
    phase = reconnectAttempts > 0 ? CameraPhase.reconnecting : CameraPhase.connecting;
    _notify();
    _sendTelemetry();
    try {
      await CgStreamer.start(target.srtUrl);
    } on PlatformException catch (e) {
      _onFailure(e.message ?? 'Could not start streaming.');
    }
  }

  void _onPublisher(PublisherEvent e) {
    switch (e.state) {
      case PublisherState.live:
        _publisherConnected = true;
        phase = appInBackground && defaultTargetPlatform == TargetPlatform.iOS ? CameraPhase.paused : CameraPhase.live;
        message = null;
        liveSince ??= DateTime.now();
        reconnectAttempts = 0;
        _backoff.reset();
      case PublisherState.connecting:
        if (phase != CameraPhase.live) {
          phase = reconnectAttempts > 0 ? CameraPhase.reconnecting : CameraPhase.connecting;
        }
      case PublisherState.disconnected:
      case PublisherState.error:
        _publisherConnected = false;
        if (wantLive) {
          _onFailure(e.message ?? 'Connection to the ingest server was lost.');
        } else {
          phase = CameraPhase.ready;
          message = e.message;
        }
      case PublisherState.interrupted:
        phase = CameraPhase.paused;
        message = e.message ?? 'The camera is paused by the system.';
      case PublisherState.resumed:
        message = null;
        if (!wantLive) {
          phase = CameraPhase.ready;
        } else if (_publisherConnected) {
          phase = CameraPhase.live;
        } else {
          unawaited(_startPublish());
        }
      case PublisherState.stopped:
        // Android reports "stopped" after a failed connection too; only an explicit stop resets the UI.
        _publisherConnected = false;
        if (!wantLive) {
          phase = CameraPhase.ready;
          liveSince = null;
        }
      case PublisherState.idle:
        break;
    }
    _sendTelemetry();
    _notify();
  }

  void _onFailure(String msg) {
    _publisherConnected = false;
    if (!wantLive) return;
    final lower = msg.toLowerCase();
    if (lower.contains('refused') || lower.contains('key') || lower.contains('reject')) {
      _refreshKeyBeforeRetry = true;
    }
    reconnectAttempts++;
    phase = CameraPhase.reconnecting;
    message = msg;
    final delay = _backoff.next();
    retryAt = DateTime.now().add(delay);
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () async {
      if (!wantLive || _disposed) return;
      if (_refreshKeyBeforeRetry) {
        try {
          target = await _api.publishTarget(camera.id);
          _refreshKeyBeforeRetry = false;
        } on ApiException {
          // server unreachable: retry with the key we have
        }
      }
      await _startPublish();
    });
    _notify();
  }

  // ---------------------------------------------------------------- server link
  void _onServerMessage(Map<String, dynamic> m) {
    switch (m['type']) {
      case 'tally':
        onAir = m['onAir'] == true;
        inPreview = m['preview'] == true;
        if (onAir) HapticFeedback.mediumImpact();
      case 'camera.joined':
      case 'camera.updated':
        camera = CameraInfo.fromJson(m['camera'] as Map<String, dynamic>);
      case 'camera.removed':
        removedByDirector = true;
        message = 'The director removed this camera from the tournament.';
        unawaited(stopLive());
      case 'error':
        if (m['code'] == 'unauthorized') message = '${m['message']}';
    }
    _notify();
  }

  String get _telemetryState => switch (phase) {
        CameraPhase.starting => 'idle',
        CameraPhase.ready => 'previewing',
        CameraPhase.connecting => 'connecting',
        CameraPhase.live => 'live',
        CameraPhase.reconnecting => 'reconnecting',
        CameraPhase.paused => 'paused',
        CameraPhase.error => 'error',
      };

  void _sendTelemetry() {
    final l = link;
    if (l == null || !l.isConnected) return;
    final t = CameraTelemetry(
      state: _telemetryState,
      bitrateKbps: phase == CameraPhase.live ? uploadKbps : 0,
      battery: device?.battery,
      charging: device?.charging,
      durationSec: liveSince == null ? null : liveFor.inSeconds,
      appState: appInBackground ? 'background' : 'foreground',
      resolution: actual['width'] != null ? '${actual['width']}x${actual['height']}' : null,
      fps: actual['fps'] as int?,
      thermal: device?.thermal,
      error: phase == CameraPhase.reconnecting || phase == CameraPhase.error ? message : null,
    );
    l.send({'type': 'telemetry', 'telemetry': t.toJson()});
  }

  // ---------------------------------------------------------------- lifecycle
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final bg = state == AppLifecycleState.paused || state == AppLifecycleState.hidden || state == AppLifecycleState.detached;
    if (bg == appInBackground) return;
    appInBackground = bg;
    if (!bg) unawaited(_refreshDevice());
    _sendTelemetry();
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> close() async {
    wantLive = false;
    _retryTimer?.cancel();
    _telemetryTimer?.cancel();
    _deviceTimer?.cancel();
    _tick?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    try {
      await CgStreamer.stop();
      await CgStreamer.dispose();
      await CgStreamer.setKeepScreenOn(false);
    } on PlatformException {
      // ignore during teardown
    }
    await _stateSub?.cancel();
    await _kbpsSub?.cancel();
    await _msgSub?.cancel();
    link?.state.removeListener(_notify);
    await link?.close();
    _api.close();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
