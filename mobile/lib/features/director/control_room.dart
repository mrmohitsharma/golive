import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';

class CommandOutcome {
  CommandOutcome(this.action, this.ok, this.error);
  final String action;
  final bool ok;
  final String? error;
}

/// Director Mode state. All switching goes server -> OBS agent -> OBS; this class never
/// pretends a switch happened: `programmeCameraId` only changes when OBS reports it.
class ControlRoom extends ChangeNotifier {
  ControlRoom({required this.session, required this.tournament});

  final Session session;
  Tournament tournament;
  late final ApiClient api = session.api();
  late final RealtimeLink link = RealtimeLink(
    serverUrl: session.serverUrl,
    token: session.token!,
    onOpenMessages: () => [
      {'type': 'subscribe', 'tournamentId': tournament.id},
    ],
  );

  List<CameraInfo> cameras = const [];
  List<Commentator> commentators = const [];
  EngineState engine = const EngineState();
  GraphicsState graphics = const GraphicsState();
  AudioState audio = const AudioState();
  ProductionState production = const ProductionState();
  YoutubeState youtube = const YoutubeState();
  OutputsState outputs = const OutputsState();
  TournamentBilling billing = const TournamentBilling();
  List<LeaderboardRow> leaderboard = const [];

  /// Peak dB per OBS input (e.g. "CG cam-3 Feed", "CG Commentary com-1"), ~4x per second.
  Map<String, double> meters = const {};
  DateTime? metersAt;

  /// Clips made in this session, newest first (status updates arrive live).
  final List<HighlightClip> recentClips = [];

  bool mediaServerReachable = true;
  String? mediaServerError;
  bool snapshotLoaded = false;
  final List<AlertMessage> alerts = [];
  final Map<String, String> pending = {}; // requestId -> action
  String? localPreviewId; // highlighted before the engine confirms
  CommandOutcome? lastOutcome;

  StreamSubscription<Map<String, dynamic>>? _sub;
  int _seq = 0;
  bool _disposed = false;

  CameraInfo? byId(String? id) {
    if (id == null) return null;
    for (final c in cameras) {
      if (c.id == id) return c;
    }
    return null;
  }

  CameraInfo? get programme => byId(engine.programmeCameraId);
  CameraInfo? get preview => byId(engine.previewCameraId ?? localPreviewId);
  bool get linkConnected => link.state.value == LinkState.connected;
  bool get metersFresh => metersAt != null && DateTime.now().difference(metersAt!) < const Duration(seconds: 2);

  double? meterFor(String obsInput) => metersFresh ? meters[obsInput] : null;

  /// OBS input name for a camera feed (same rule as the server and agent).
  static String feedInput(CameraInfo c) => 'CG ${c.streamPath} Feed';

  void start() {
    _sub = link.messages.listen(_onMessage);
    link.state.addListener(_notify);
    link.connect();
  }

  void _onMessage(Map<String, dynamic> m) {
    switch (m['type']) {
      case 'snapshot':
        cameras = _parseCameras(m['cameras']);
        commentators = _parseCommentators(m['commentators']);
        engine = EngineState.fromJson(m['engine'] as Map<String, dynamic>?);
        graphics = GraphicsState.fromJson(m['graphics'] as Map<String, dynamic>?);
        audio = AudioState.fromJson(m['audio'] as Map<String, dynamic>?);
        production = ProductionState.fromJson(m['production'] as Map<String, dynamic>?);
        youtube = YoutubeState.fromJson(m['youtube'] as Map<String, dynamic>?);
        outputs = OutputsState.fromJson(m['outputs'] as Map<String, dynamic>?);
        billing = TournamentBilling.fromJson(m['billing'] as Map<String, dynamic>?);
        leaderboard = parseLeaderboard(m['leaderboard']);
        final t = m['tournament'] as Map<String, dynamic>?;
        if (t != null) tournament = Tournament.fromJson({...t, 'orgId': tournament.orgId, 'role': tournament.role?.name});
        _media(m['mediaServer']);
        snapshotLoaded = true;
      case 'cameras':
        cameras = _parseCameras(m['cameras']);
        if (m['commentators'] != null) commentators = _parseCommentators(m['commentators']);
        _media(m['mediaServer']);
      case 'engine':
        engine = EngineState.fromJson(m['engine'] as Map<String, dynamic>?);
        if (engine.previewCameraId != null) localPreviewId = null;
      case 'graphics':
        graphics = GraphicsState.fromJson(m['graphics'] as Map<String, dynamic>?);
      case 'audio':
        audio = AudioState.fromJson(m['audio'] as Map<String, dynamic>?);
      case 'production':
        production = ProductionState.fromJson(m['production'] as Map<String, dynamic>?);
      case 'youtube':
        youtube = YoutubeState.fromJson(m['youtube'] as Map<String, dynamic>?);
      case 'outputs':
        final prev = {for (final p in outputs.platforms) p.platform: p.state};
        final prevDest = {for (final d in outputs.destinations) d.id: d.state};
        outputs = OutputsState.fromJson(m['outputs'] as Map<String, dynamic>?);
        for (final p in outputs.platforms) {
          if (prev[p.platform] == 'live' && p.state == 'retrying') _alert('warning', '${p.platform.label} dropped: ${p.error ?? 'retrying'}');
          if (prev[p.platform] != 'live' && prev[p.platform] != null && p.state == 'live') _alert('info', 'Live on ${p.platform.label}');
        }
        for (final d in outputs.destinations) {
          if (prevDest[d.id] == 'live' && d.state == 'retrying') _alert('warning', '${d.label} dropped: ${d.error ?? 'retrying'}');
          if (prevDest[d.id] != 'live' && prevDest[d.id] != null && d.state == 'live') _alert('info', 'Live on ${d.label}');
        }
      case 'billing':
        billing = TournamentBilling.fromJson(m['billing'] as Map<String, dynamic>?);
      case 'leaderboard':
        leaderboard = parseLeaderboard(m['rows']);
      case 'meters':
        final levels = m['levels'];
        if (levels is Map) {
          meters = {for (final e in levels.entries) if (e.value is num) '${e.key}': (e.value as num).toDouble()};
          metersAt = DateTime.now();
        }
      case 'clip':
        final c = HighlightClip.fromJson(m['clip'] as Map<String, dynamic>);
        final i = recentClips.indexWhere((x) => x.id == c.id);
        if (i >= 0) {
          final wasWorking = recentClips[i].working;
          recentClips[i] = c;
          if (wasWorking && c.status == ClipStatus.ready) _alert('info', 'Clip ready: ${c.headline}');
          if (wasWorking && c.status == ClipStatus.failed) _alert('error', 'Clip failed: ${c.error ?? ''}');
        } else {
          recentClips.insert(0, c);
        }
      case 'command.result':
        final id = m['requestId'] as String?;
        final action = id == null ? '${m['action']}' : (pending.remove(id) ?? '${m['action']}');
        lastOutcome = CommandOutcome(action, m['ok'] == true, m['error'] as String?);
        if (m['ok'] != true) {
          _alert('error', '${_label(action)} failed: ${m['error'] ?? 'unknown error'}');
          if (action == 'preview') localPreviewId = null;
        }
      case 'alert':
        _alert('${m['level']}', '${m['message']}');
      case 'error':
        _alert('error', '${m['message']}');
      default:
        return; // pong etc.: nothing changed
    }
    _notify();
  }

  void _media(Object? m) {
    if (m is Map) {
      mediaServerReachable = m['reachable'] == true;
      mediaServerError = m['error'] as String?;
    }
  }

  List<CameraInfo> _parseCameras(Object? list) =>
      ((list as List?) ?? const []).map((c) => CameraInfo.fromJson(c as Map<String, dynamic>)).toList();

  List<Commentator> _parseCommentators(Object? list) =>
      ((list as List?) ?? const []).map((c) => Commentator.fromJson(c as Map<String, dynamic>)).toList();

  void _alert(String level, String message) {
    alerts.insert(0, AlertMessage(level: level, message: message));
    if (alerts.length > 30) alerts.removeLast();
  }

  static String _label(String action) => switch (action) {
        'preview' => 'Preview',
        'take' => 'Take',
        'cut' => 'Cut',
        'fallback' => 'Fallback',
        'replay' => 'Replay',
        'stream.start' => 'Start YouTube',
        'stream.stop' => 'Stop YouTube',
        _ => action,
      };

  String _command(String action, {String? cameraId, Map<String, Object?> extra = const {}}) {
    final requestId = 'r${DateTime.now().millisecondsSinceEpoch}-${_seq++}';
    pending[requestId] = action;
    link.send({'type': 'command', 'action': action, if (cameraId != null) 'cameraId': cameraId, 'requestId': requestId, ...extra});
    if (!linkConnected) {
      pending.remove(requestId);
      _alert('error', 'Not connected to the server. ${_label(action)} was not sent.');
    }
    _notify();
    return requestId;
  }

  bool isPending(String action) => pending.containsValue(action);

  void previewCamera(CameraInfo c) {
    localPreviewId = c.id;
    _command('preview', cameraId: c.id);
  }

  /// Puts the current preview on air (the classic PREVIEW -> TAKE workflow).
  void take() => _command('take');

  /// One-tap: put this camera on air immediately.
  void cut(CameraInfo c) => _command('cut', cameraId: c.id);

  void fallback() => _command('fallback');

  /// Instant replay: the last [seconds] of a camera, played on air (with the REPLAY bug),
  /// then back to the live camera automatically.
  void replay(CameraInfo c, {int seconds = 10, bool slowmo = false}) =>
      _command('replay', cameraId: c.id, extra: {'seconds': seconds, 'slowmo': slowmo});

  void startYouTube() => _command('stream.start');

  void stopYouTube() => _command('stream.stop');

  Future<String?> _try(Future<void> Function() f) async {
    try {
      await f();
      return null;
    } on ApiException catch (e) {
      _alert('error', e.message);
      _notify();
      return e.message;
    }
  }

  /// Graphics changes are pushed back over the WebSocket; set locally too so the UI is snappy.
  Future<String?> setGraphics(Map<String, Object?> patch) => _try(() async {
        graphics = await api.setGraphics(tournament.id, patch);
        _notify();
      });

  Future<String?> setAudio(Map<String, Object?> patch) => _try(() async {
        audio = await api.setAudio(tournament.id, patch);
        _notify();
      });

  Future<String?> saveClip(String cameraId, {int seconds = 30, String? title}) => _try(() async {
        final c = await api.createClip(tournament.id, cameraId: cameraId, secondsBack: seconds, durationSec: seconds, title: title);
        if (!recentClips.any((x) => x.id == c.id)) recentClips.insert(0, c);
        _alert('info', 'Making clip: ${c.headline} (${c.durationSec}s)');
        _notify();
      });

  Future<String?> createBroadcast({String? title, String privacy = 'unlisted'}) => _try(() async {
        youtube = await api.createBroadcast(tournament.id, title: title, privacy: privacy);
        _notify();
      });

  Future<String?> startCloudEngine() => _try(() async {
        production = await api.startCloudEngine(tournament.id);
        _notify();
      });

  Future<String?> stopCloudEngine({bool force = false}) => _try(() async {
        production = await api.stopCloudEngine(tournament.id, force: force);
        _notify();
      });

  Future<void> setAutoFallback(bool on) async {
    await _try(() async {
      final t = await api.setAutoFallback(tournament.id, on);
      tournament = Tournament.fromJson({
        'id': t.id,
        'name': t.name,
        'venue': t.venue,
        'mode': t.mode.name,
        'autoFallback': t.autoFallback,
        'orgId': tournament.orgId,
        'role': tournament.role?.name,
      });
    });
    _notify();
  }

  Future<String?> updateCamera(CameraInfo c, {required String name, int? hole, required String position}) async {
    try {
      await api.updateCamera(c.id, name: name, hole: hole, clearHole: hole == null, position: position);
      return null;
    } on ApiException catch (e) {
      return e.message;
    }
  }

  Future<String?> removeCamera(CameraInfo c) => _try(() => api.removeCamera(c.id));

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    link.state.removeListener(_notify);
    link.close();
    api.close();
    super.dispose();
  }
}
