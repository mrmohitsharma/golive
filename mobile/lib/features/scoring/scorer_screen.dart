import 'dart:async';

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/score_book.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// Hole-by-hole score entry for a scorer walking with a group, plus the live leaderboard.
/// Entries are queued on the phone (ScoreBook) so dead spots on the course lose nothing.
class ScorerScreen extends StatefulWidget {
  const ScorerScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<ScorerScreen> createState() => _ScorerScreenState();
}

class _ScorerScreenState extends State<ScorerScreen> {
  late final ApiClient _api = widget.session.api();
  late final ScoreBook _book = ScoreBook(api: _api, tournamentId: _tid)..onSaved = _onSaved;
  List<Hole> _holes = const [];
  List<Player> _players = const [];
  Map<String, LeaderboardRow> _rows = {};
  List<LeaderboardRow> _board = const [];
  int _hole = 1;
  int? _group;
  bool _loaded = false;
  String? _error;
  Timer? _poll;

  String get _tid => widget.tournament.id;
  String get _prefsHole => 'scores.hole.$_tid';
  String get _prefsGroup => 'scores.group.$_tid';

  @override
  void initState() {
    super.initState();
    _book.addListener(_changed);
    _init();
    _poll = Timer.periodic(const Duration(seconds: 20), (_) => _loadBoard());
  }

  @override
  void dispose() {
    _poll?.cancel();
    _book.removeListener(_changed);
    _book.dispose();
    _api.close();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _init() async {
    final p = await SharedPreferences.getInstance();
    _hole = p.getInt(_prefsHole) ?? 1;
    _group = p.getInt(_prefsGroup);
    await _load();
    await _book.load();
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([_api.holes(_tid), _api.players(_tid), _api.leaderboard(_tid)]);
      if (!mounted) return;
      setState(() {
        _holes = r[0] as List<Hole>;
        _players = r[1] as List<Player>;
        _setBoard(r[2] as List<LeaderboardRow>);
        if (_holes.isNotEmpty && !_holes.any((h) => h.number == _hole)) _hole = _holes.first.number;
        _loaded = true;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _loadBoard() async {
    try {
      final b = await _api.leaderboard(_tid);
      if (mounted) setState(() => _setBoard(b));
    } on ApiException {
      // keep the last board; the queue banner already says we're offline
    }
  }

  void _setBoard(List<LeaderboardRow> b) {
    _board = b;
    _rows = {for (final r in b) r.playerId: r};
  }

  void _onSaved(LeaderboardRow row) {
    _rows[row.playerId] = row;
    unawaited(_loadBoard());
  }

  Future<void> _setHole(int h) async {
    setState(() => _hole = h);
    await (await SharedPreferences.getInstance()).setInt(_prefsHole, h);
  }

  Future<void> _setGroup(int? g) async {
    setState(() => _group = g);
    final p = await SharedPreferences.getInstance();
    if (g == null) {
      await p.remove(_prefsGroup);
    } else {
      await p.setInt(_prefsGroup, g);
    }
  }

  int get _par => _holes.firstWhere((h) => h.number == _hole, orElse: () => Hole(number: _hole, par: 4)).par;

  /// What to show for a player on the current hole: queued value first, then the server's.
  (int?, bool) _strokes(String playerId) {
    final p = _book.pendingFor(playerId, _hole);
    if (p != null) return (p.strokes, true);
    return (_rows[playerId]?.scores[_hole], false);
  }

  @override
  Widget build(BuildContext context) {
    final groups = {for (final p in _players) if (p.groupNo != null) p.groupNo!}.toList()..sort();
    final shown = _players.where((p) => _group == null || p.groupNo == _group).toList();
    final holeNumbers = _holes.isEmpty ? [for (var i = 1; i <= 18; i++) i] : [for (final h in _holes) h.number];
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.tournament.name, overflow: TextOverflow.ellipsis),
          actions: [if (widget.session.isGuest) SignOutButton(session: widget.session)],
          bottom: const TabBar(tabs: [Tab(text: 'Enter scores'), Tab(text: 'Leaderboard')]),
        ),
        body: TabBarView(children: [
          Column(children: [
            if (_book.pendingCount > 0)
              Container(
                width: double.infinity,
                color: _book.offline ? Broadcast.warning.withValues(alpha: 0.25) : Broadcast.panelHigh,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                child: Row(children: [
                  Icon(_book.offline ? Icons.cloud_off : Icons.cloud_upload, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(_book.offline
                        ? '${_book.pendingCount} score(s) saved on this phone. They send automatically when signal returns.'
                        : 'Sending ${_book.pendingCount} score(s)…'),
                  ),
                  TextButton(onPressed: _book.flush, child: const Text('Retry')),
                ]),
              ),
            for (final e in _book.errors.take(1))
              Padding(padding: const EdgeInsets.fromLTRB(12, 8, 12, 0), child: InfoBanner(icon: Icons.error_outline, text: e, error: true)),
            if (_error != null) Padding(padding: const EdgeInsets.all(12), child: InfoBanner(icon: Icons.error_outline, text: _error!, error: true)),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
              child: Row(children: [
                IconButton(
                  onPressed: holeNumbers.indexOf(_hole) > 0 ? () => _setHole(holeNumbers[holeNumbers.indexOf(_hole) - 1]) : null,
                  icon: const Icon(Icons.chevron_left),
                ),
                Expanded(
                  child: Column(children: [
                    Text('HOLE $_hole', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    Text('Par $_par', style: Theme.of(context).textTheme.bodyMedium),
                  ]),
                ),
                IconButton(
                  onPressed: holeNumbers.indexOf(_hole) < holeNumbers.length - 1 ? () => _setHole(holeNumbers[holeNumbers.indexOf(_hole) + 1]) : null,
                  icon: const Icon(Icons.chevron_right),
                ),
              ]),
            ),
            SizedBox(
              height: 44,
              child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 8), children: [
                for (final h in holeNumbers)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: ChoiceChip(label: Text('$h'), selected: h == _hole, onSelected: (_) => _setHole(h)),
                  ),
              ]),
            ),
            if (groups.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: DropdownButtonFormField<int?>(
                  initialValue: _group,
                  isDense: true,
                  decoration: const InputDecoration(labelText: 'My group'),
                  items: [
                    const DropdownMenuItem<int?>(value: null, child: Text('All players')),
                    for (final g in groups) DropdownMenuItem<int?>(value: g, child: Text('Group $g')),
                  ],
                  onChanged: _setGroup,
                ),
              ),
            const SizedBox(height: 4),
            Expanded(
              child: !_loaded && _error == null
                  ? const Center(child: CircularProgressIndicator())
                  : shown.isEmpty
                      ? const Center(child: Padding(padding: EdgeInsets.all(24), child: Text('No players yet. The organiser adds them in Course & players.')))
                      : ListView.separated(
                          padding: const EdgeInsets.only(bottom: 24),
                          itemCount: shown.length,
                          separatorBuilder: (_, _) => const Divider(height: 1),
                          itemBuilder: (_, i) {
                            final p = shown[i];
                            final (strokes, queued) = _strokes(p.id);
                            return _ScoreRow(
                              player: p,
                              row: _rows[p.id],
                              strokes: strokes,
                              par: _par,
                              queued: queued,
                              onSet: (v) => _book.set(p.id, _hole, v),
                            );
                          },
                        ),
            ),
          ]),
          RefreshIndicator(
            onRefresh: _loadBoard,
            child: ListView(children: [
              for (final r in _board)
                ListTile(
                  dense: true,
                  leading: SizedBox(width: 36, child: Text(r.position.isEmpty ? '–' : r.position, style: const TextStyle(fontWeight: FontWeight.w700))),
                  title: Text(r.name),
                  subtitle: Text([r.club, r.category].whereType<String>().where((s) => s.isNotEmpty).join(' · ')),
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    Text(r.toParText,
                        style: TextStyle(
                            fontWeight: FontWeight.w800,
                            fontSize: 16,
                            color: (r.toPar ?? 0) < 0 ? Broadcast.onAir : null)),
                    const SizedBox(width: 16),
                    SizedBox(width: 28, child: Text(r.thru, textAlign: TextAlign.end)),
                  ]),
                ),
              if (_board.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Text('No scores yet.')),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _ScoreRow extends StatelessWidget {
  const _ScoreRow({required this.player, required this.row, required this.strokes, required this.par, required this.queued, required this.onSet});
  final Player player;
  final LeaderboardRow? row;
  final int? strokes;
  final int par;
  final bool queued;
  final ValueChanged<int?> onSet;

  @override
  Widget build(BuildContext context) {
    final s = strokes;
    final diff = s == null ? null : s - par;
    final color = diff == null
        ? null
        : diff < 0
            ? Broadcast.onAir
            : diff == 0
                ? Broadcast.preview
                : Colors.blueGrey;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(player.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
            Text(
              [if (row != null && row!.position.isNotEmpty) '${row!.position} · ${row!.toParText} thru ${row!.thru}', player.club]
                  .whereType<String>()
                  .where((x) => x.isNotEmpty)
                  .join(' · '),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ]),
        ),
        IconButton.filledTonal(onPressed: s != null && s > 1 ? () => onSet(s - 1) : (s == null ? () => onSet(par - 1) : null), icon: const Icon(Icons.remove)),
        GestureDetector(
          onTap: () => onSet(s ?? par),
          onLongPress: s == null ? null : () => onSet(null),
          child: Container(
            width: 56,
            height: 48,
            margin: const EdgeInsets.symmetric(horizontal: 6),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: color?.withValues(alpha: 0.25),
              border: Border.all(color: color ?? Colors.white24, width: 2),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Stack(clipBehavior: Clip.none, children: [
              Text(s?.toString() ?? '–', style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: s == null ? Colors.white38 : null)),
              if (queued) const Positioned(right: -14, top: -6, child: Icon(Icons.cloud_upload, size: 12, color: Broadcast.warning)),
            ]),
          ),
        ),
        IconButton.filledTonal(onPressed: s == null ? () => onSet(par + 1) : (s < 20 ? () => onSet(s + 1) : null), icon: const Icon(Icons.add)),
      ]),
    );
  }
}
