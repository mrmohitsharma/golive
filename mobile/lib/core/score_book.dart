import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'models.dart';

/// One entry waiting to reach the server. `strokes == null` clears the score.
class PendingScore {
  const PendingScore({required this.playerId, required this.hole, required this.strokes});
  final String playerId;
  final int hole;
  final int? strokes;

  String get key => '$playerId:$hole';

  Map<String, dynamic> toJson() => {'playerId': playerId, 'hole': hole, 'strokes': strokes};
  factory PendingScore.fromJson(Map<String, dynamic> j) =>
      PendingScore(playerId: j['playerId'] as String, hole: (j['hole'] as num).toInt(), strokes: (j['strokes'] as num?)?.toInt());
}

/// Scores a scorer has entered. Every entry is saved on the phone first and sent in order;
/// with no signal on the back nine they wait and go out automatically when it returns,
/// even after the app is restarted. The latest entry for a player+hole wins.
class ScoreBook extends ChangeNotifier {
  ScoreBook({required this.api, required this.tournamentId, this.retryEvery = const Duration(seconds: 10)});

  final ApiClient api;
  final String tournamentId;
  final Duration retryEvery;

  /// Insertion-ordered: oldest first.
  final Map<String, PendingScore> _pending = {};
  final List<String> errors = [];
  bool _flushing = false;
  bool _disposed = false;
  bool offline = false;
  Timer? _retry;

  /// Called with the server's view of a player after each successful save.
  void Function(LeaderboardRow row)? onSaved;

  String get _prefsKey => 'scores.pending.$tournamentId';
  List<PendingScore> get pending => List.unmodifiable(_pending.values);
  int get pendingCount => _pending.length;

  PendingScore? pendingFor(String playerId, int hole) => _pending['$playerId:$hole'];

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_prefsKey);
    if (raw != null) {
      try {
        for (final e in jsonDecode(raw) as List) {
          final s = PendingScore.fromJson(e as Map<String, dynamic>);
          _pending[s.key] = s;
        }
      } on Object {
        // corrupted: start clean rather than block scoring
      }
    }
    _notify();
    await flush();
  }

  Future<void> _persist() async {
    final p = await SharedPreferences.getInstance();
    if (_pending.isEmpty) {
      await p.remove(_prefsKey);
    } else {
      await p.setString(_prefsKey, jsonEncode([for (final s in _pending.values) s.toJson()]));
    }
  }

  /// Record a score (or clear it with null) and try to send it now.
  Future<void> set(String playerId, int hole, int? strokes) async {
    final s = PendingScore(playerId: playerId, hole: hole, strokes: strokes);
    _pending.remove(s.key); // re-insert at the end: newest last
    _pending[s.key] = s;
    await _persist();
    _notify();
    await flush();
  }

  /// Sends queued scores in order. Stops at the first network failure and retries later;
  /// entries the server rejects (e.g. a deleted player) are dropped and reported.
  Future<void> flush() async {
    if (_flushing || _disposed) return;
    _flushing = true;
    _retry?.cancel();
    try {
      while (_pending.isNotEmpty && !_disposed) {
        final s = _pending.values.first;
        try {
          final row = await api.setScore(tournamentId, playerId: s.playerId, hole: s.hole, strokes: s.strokes);
          offline = false;
          // Only remove if not replaced by a newer entry while the request was in flight.
          if (identical(_pending[s.key], s)) _pending.remove(s.key);
          if (row != null) onSaved?.call(row);
        } on ApiException catch (e) {
          if (e.isNetwork || (e.status != null && e.status! >= 500)) {
            offline = true;
            break;
          }
          if (identical(_pending[s.key], s)) _pending.remove(s.key);
          errors.insert(0, 'Hole ${s.hole}: ${e.message}');
          if (errors.length > 10) errors.removeLast();
        }
        await _persist();
        _notify();
      }
    } finally {
      _flushing = false;
      _notify();
      if (_pending.isNotEmpty && !_disposed) _retry = Timer(retryEvery, flush);
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _retry?.cancel();
    super.dispose();
  }
}
