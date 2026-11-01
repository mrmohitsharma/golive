import 'dart:async';
import 'dart:math' as math;

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
  StreamConfig config;

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

  /// The show ended (the server paused the cameras); [_resumeAfterShow] = it was sending before.
  bool pausedByShow = false;
  bool _resumeAfterShow = false;
  Map<String, Object?> actual = const {};

  // ---------------------------------------------------------------- camera controls
  CameraCaps caps = const CameraCaps();
  double zoom = 1;
  double ev = 0;
  bool autoFocus = true;
  double focusNear = 0;
  bool aeAfLocked = false;
  bool torch = false;

  /// Every on-screen control frozen (pocket / sweat touches can't change the shot).
  bool controlsLocked = false;
  bool lensSwitching = false;
  bool get portrait => config.portrait;

  /// Microphone level 0..1 for the meter (its own notifier: 10 updates a second).
  final ValueNotifier<double> audioLevel = ValueNotifier(0);
  StreamSubscription<double>? _audioSub;
  StreamSubscription<bool>? _lensSub;
  StreamSubscription<bool>? _callSub;

  /// The operator muted the mic (silence is sent; the director sees MIC OFF).
  bool micMuted = false;

  /// A phone call rings or is in progress: video goes on, the OS silences the mic.
  bool inCall = false;

  /// Bumped when the app comes back on screen, so the screen can rebuild the preview view.
  int resumeCount = 0;

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
      // Redraw only for a visible change (saves rebuilding the screen every second).
      final changed = (k - uploadKbps).abs() >= math.max(100, uploadKbps ~/ 10);
      uploadKbps = k;
      if (changed) _notify();
    });
    _callSub = CgStreamer.phoneCall.listen((on) {
      inCall = on;
      if (on) HapticFeedback.heavyImpact();
      _sendTelemetry(force: true);
      _notify();
    });
    _audioSub = CgStreamer.audioLevel.listen((l) => audioLevel.value = l);
    _lensSub = CgStreamer.lensSwitching.listen((on) {
      lensSwitching = on;
      if (!on) unawaited(_refreshCaps());
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
      await _refreshCaps();
      _capsLater();
    } on PlatformException catch (e) {
      phase = CameraPhase.error;
      message = e.message ?? 'The camera could not be opened.';
    }
    await CgStreamer.setKeepScreenOn(true);
    await _refreshDevice();

    // Changes go out at once; otherwise a heartbeat every 5 s (the server treats 15 s as stale).
    _telemetryTimer = Timer.periodic(const Duration(seconds: 5), (_) => _sendTelemetry(force: true));
    _deviceTimer = Timer.periodic(const Duration(seconds: 30), (_) => _refreshDevice());
    // Only the reconnect countdown needs a redraw every second (the live clock ticks by itself).
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (retryAt != null) _notify();
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
    pausedByShow = false;
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

  Future<void> _pauseForShowEnd(String why) async {
    if (pausedByShow) return;
    _resumeAfterShow = wantLive;
    pausedByShow = true;
    await stopLive();
    message = why;
    _notify();
  }

  Future<void> switchCamera() async {
    try {
      await CgStreamer.switchCamera();
      zoom = 1;
      torch = false;
      aeAfLocked = false;
      _notify();
      await Future<void>.delayed(const Duration(milliseconds: 900));
      await _refreshCaps();
    } on PlatformException catch (e) {
      message = e.message;
      _notify();
    }
  }

  Future<void> setMicMuted(bool muted) async {
    micMuted = muted;
    HapticFeedback.selectionClick();
    _notify();
    try {
      await CgStreamer.setMicMuted(muted);
    } on PlatformException catch (e) {
      micMuted = !muted;
      message = e.message;
    }
    _sendTelemetry(force: true);
    _notify();
  }

  // ---------------------------------------------------------------- camera controls
  Future<void> _refreshCaps() async {
    try {
      caps = await CgStreamer.cameraCaps();
      zoom = zoom.clamp(caps.zoomMin, caps.zoomMax).toDouble();
      _notify();
    } on PlatformException {
      // older plugin / camera closed: controls stay hidden
    } on MissingPluginException {
      // same
    }
  }

  /// The camera opens with the preview a moment after initialize: read what it can do again.
  void _capsLater() {
    for (final ms in const [1200, 2500]) {
      Future<void>.delayed(Duration(milliseconds: ms), () {
        if (!_disposed) unawaited(_refreshCaps());
      });
    }
  }

  // Dragging an arc sends many values: one native call at a time, always the latest value.
  final Map<String, double> _pending = {};
  final Set<String> _busy = {};
  Future<void> _send(String key, double value, Future<void> Function(double) call) async {
    _pending[key] = value;
    if (_busy.contains(key)) return;
    _busy.add(key);
    try {
      while (_pending.containsKey(key)) {
        final v = _pending.remove(key)!;
        try {
          await call(v);
        } on PlatformException catch (e) {
          message = e.message;
          _notify();
        }
      }
    } finally {
      _busy.remove(key);
    }
  }

  void setZoom(double z) {
    final v = z.clamp(caps.zoomMin, caps.zoomMax).toDouble();
    if ((v - zoom).abs() < 0.005) return;
    zoom = v;
    _notify();
    unawaited(_send('zoom', v, CgStreamer.setZoom));
  }

  void setBrightness(double value) {
    final v = value.clamp(caps.evMin, caps.evMax).toDouble();
    ev = (v / caps.evStep).round() * caps.evStep;
    _notify();
    unawaited(_send('ev', ev, CgStreamer.setExposureBias));
  }

  /// Tap on the picture: focus and set brightness there (also ends a lock).
  Future<void> focusAt(double x, double y) async {
    aeAfLocked = false;
    _notify();
    try {
      await CgStreamer.focusAt(x, y);
    } on PlatformException catch (e) {
      message = e.message;
      _notify();
    }
  }

  /// Long-press on the picture: hold focus and brightness on that point.
  Future<void> lockAt(double x, double y) async {
    aeAfLocked = true;
    HapticFeedback.mediumImpact();
    _notify();
    try {
      await CgStreamer.setAeAfLock(true, x: x, y: y);
    } on PlatformException catch (e) {
      aeAfLocked = false;
      message = e.message;
      _notify();
    }
  }

  Future<void> unlockAeAf() async {
    aeAfLocked = false;
    _notify();
    try {
      await CgStreamer.setAeAfLock(false);
    } on PlatformException catch (e) {
      message = e.message;
      _notify();
    }
  }

  Future<void> setAutoFocus(bool on) async {
    autoFocus = on;
    _notify();
    try {
      await CgStreamer.setAutoFocus(on);
    } on PlatformException catch (e) {
      message = e.message;
      _notify();
    }
  }

  void setFocusNear(double near) {
    focusNear = near.clamp(0, 1).toDouble();
    _notify();
    unawaited(_send('focus', focusNear, CgStreamer.setFocusDistance));
  }

  Future<void> toggleTorch() async {
    final want = !torch;
    torch = want;
    _notify();
    try {
      await CgStreamer.setTorch(want);
    } on PlatformException catch (e) {
      torch = false;
      message = e.message;
      _notify();
    }
  }

  void setControlsLocked(bool on) {
    controlsLocked = on;
    HapticFeedback.selectionClick();
    _notify();
  }

  /// Portrait (9:16) or landscape (16:9). Not while ON AIR: the camera reconnects (a few seconds).
  /// The screen must already be turned (the caller sets the allowed orientations first).
  Future<bool> setPortrait(bool on) async {
    if (on == portrait) return true;
    if (onAir) {
      message = 'Change portrait / landscape when this camera is not ON AIR.';
      _notify();
      return false;
    }
    final resume = wantLive;
    if (resume) await stopLive();
    config = config.copyWith(portrait: on);
    phase = CameraPhase.starting;
    _notify();
    // Give the screen time to turn: the camera reads the screen's rotation.
    await Future<void>.delayed(const Duration(milliseconds: 700));
    try {
      actual = await CgStreamer.initialize(config);
      phase = CameraPhase.ready;
      message = on ? 'Portrait 9:16. In the 16:9 show this camera has black bars at the sides.' : null;
      if (micMuted) await CgStreamer.setMicMuted(true);
      await _refreshCaps();
      _capsLater();
    } on PlatformException catch (e) {
      phase = CameraPhase.error;
      message = e.message ?? 'The camera could not be opened.';
    }
    _sendTelemetry();
    _notify();
    if (resume && phase == CameraPhase.ready) await goLive();
    return true;
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
      case 'camera.pause':
        // The show is over: stop uploading (saves this phone's data and the server's bandwidth).
        unawaited(_pauseForShowEnd('${m['message'] ?? 'The show has ended. Tap Go live when the next show starts.'}'));
      case 'camera.resume':
        if (pausedByShow) {
          pausedByShow = false;
          message = 'The director started the next show.';
          if (_resumeAfterShow) unawaited(goLive());
          _resumeAfterShow = false;
        }
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

  String? _lastTelemetry;

  /// Sends phone status to the control room when something the director sees changed
  /// (state, mic, call, battery…); [force] = the 5 s heartbeat with the current upload rate.
  void _sendTelemetry({bool force = false}) {
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
      micMuted: micMuted,
      inCall: inCall,
    );
    final json = t.toJson();
    // What matters for the director, without the numbers that change every second.
    final sig = '${json['state']}|${json['battery']}|${json['charging']}|${json['appState']}|${json['resolution']}|${json['thermal']}|${json['error']}|$micMuted|$inCall';
    if (!force && sig == _lastTelemetry) return;
    _lastTelemetry = sig;
    l.send({'type': 'telemetry', 'telemetry': json});
  }

  // ---------------------------------------------------------------- lifecycle
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final bg = state == AppLifecycleState.paused || state == AppLifecycleState.hidden || state == AppLifecycleState.detached;
    if (bg == appInBackground) return;
    appInBackground = bg;
    if (!bg) {
      unawaited(_refreshDevice());
      // Back from a call, a notification or the home screen: redraw the preview and reopen
      // the camera if another app took it (this was the blank screen after a call).
      resumeCount++;
      unawaited(CgStreamer.resume().catchError((Object _) {}));
    }
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
      await CgStreamer.setScreenDim(false);
    } on PlatformException {
      // ignore during teardown
    }
    await _stateSub?.cancel();
    await _kbpsSub?.cancel();
    await _audioSub?.cancel();
    await _lensSub?.cancel();
    await _callSub?.cancel();
    await _msgSub?.cancel();
    link?.state.removeListener(_notify);
    await link?.close();
    _api.close();
  }

  @override
  void dispose() {
    _disposed = true;
    audioLevel.dispose();
    super.dispose();
  }
}
