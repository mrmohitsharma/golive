import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// Course card (par per hole) and the player list.
class CourseScreen extends StatefulWidget {
  const CourseScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<CourseScreen> createState() => _CourseScreenState();
}

class _CourseScreenState extends State<CourseScreen> {
  late final ApiClient _api = widget.session.api();
  List<Hole>? _holes;
  List<Player>? _players;
  String? _error;

  String get _tid => widget.tournament.id;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await Future.wait([_api.holes(_tid), _api.players(_tid)]);
      if (!mounted) return;
      setState(() {
        _holes = r[0] as List<Hole>;
        _players = r[1] as List<Player>;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _par72() async {
    final h = await guarded(context, () => _api.setPar72(_tid));
    if (h != null && mounted) setState(() => _holes = h);
  }

  Future<void> _editPar(Hole hole) async {
    final par = await showDialog<int>(
      context: context,
      builder: (c) => SimpleDialog(
        title: Text('Hole ${hole.number} par'),
        children: [for (final p in [3, 4, 5, 6]) SimpleDialogOption(onPressed: () => Navigator.pop(c, p), child: Text('Par $p', style: const TextStyle(fontSize: 18)))],
      ),
    );
    if (par == null || par == hole.par || !mounted) return;
    final next = [for (final h in _holes!) h.number == hole.number ? Hole(number: h.number, par: par, yardage: h.yardage) : h];
    final saved = await guarded(context, () => _api.setHoles(_tid, next));
    if (saved != null && mounted) setState(() => _holes = saved);
  }

  Future<void> _import() async {
    final text = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Add players'),
        content: SizedBox(
          width: 520,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('One player per line: Name, Club, Category, Group. Only the name is required. '
                'You can paste straight from Google Sheets or Excel.'),
            const SizedBox(height: 12),
            TextField(
              controller: text,
              autofocus: true,
              minLines: 6,
              maxLines: 12,
              decoration: const InputDecoration(hintText: 'Aman Sharma, DLF, Open, 1\nBhavna Rao, Karma Lakelands, Ladies, 1'),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Add')),
        ],
      ),
    );
    final csv = text.text;
    text.dispose();
    if (ok != true || csv.trim().isEmpty || !mounted) return;
    final added = await guarded(context, () => _api.importPlayers(_tid, csv));
    if (added != null && mounted) toast(context, '${added.length} players added');
    await _load();
  }

  Future<void> _delete(Player p) async {
    final ok = await confirm(context, title: 'Remove ${p.name}?', message: 'Their scores are deleted too.', action: 'Remove', destructive: true);
    if (!ok || !mounted) return;
    await guarded(context, () => _api.deletePlayer(p.id));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final holes = _holes;
    final players = _players;
    final totalPar = holes?.fold<int>(0, (a, h) => a + h.par) ?? 0;
    return Scaffold(
      appBar: AppBar(title: const Text('Course & players')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _import, icon: const Icon(Icons.person_add), label: const Text('Add players')),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          SectionCard(
            icon: Icons.flag,
            title: holes == null || holes.isEmpty ? 'Course' : 'Course · ${holes.length} holes · par $totalPar',
            children: [
              if (holes == null && _error == null) const LinearProgressIndicator(),
              if (holes != null && holes.isEmpty) ...[
                const Text('No holes yet. Start from a standard par-72 card, then tap any hole to change its par.'),
                const SizedBox(height: 8),
                Align(alignment: Alignment.centerLeft, child: FilledButton(onPressed: _par72, child: const Text('Use par-72 card'))),
              ],
              if (holes != null && holes.isNotEmpty)
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final h in holes)
                    ActionChip(
                      label: Text('${h.number}  ·  ${h.par}', style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()])),
                      onPressed: () => _editPar(h),
                    ),
                ]),
            ],
          ),
          SectionCard(
            icon: Icons.people,
            title: players == null ? 'Players' : 'Players · ${players.length}',
            children: [
              if (players != null && players.isEmpty) const Text('No players yet. Tap “Add players”.'),
              for (final p in players ?? const <Player>[])
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: CircleAvatar(radius: 16, child: Text(p.groupNo?.toString() ?? '–', style: const TextStyle(fontSize: 12))),
                  title: Text(p.name),
                  subtitle: Text([p.club, p.category].whereType<String>().where((s) => s.isNotEmpty).join(' · ')),
                  trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () => _delete(p)),
                ),
            ],
          ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}
