import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../ui/widgets.dart';

/// "Games" in the control room: fire a game for everyone watching, or settle a prediction.
/// Games are set up in the web Studio (studio link at the bottom).
class GamesSheet extends StatefulWidget {
  const GamesSheet({super.key, required this.api, required this.tournament, required this.serverUrl});
  final ApiClient api;
  final Tournament tournament;
  final String serverUrl;

  @override
  State<GamesSheet> createState() => _GamesSheetState();
}

class _GamesSheetState extends State<GamesSheet> {
  List<GameMoment>? _list;
  String? _error;
  String? _busy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final l = await widget.api.moments(widget.tournament.id);
      if (mounted) setState(() => _list = l);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _fire(GameMoment m) async {
    setState(() => _busy = m.id);
    final ok = await guarded(context, () async {
      await widget.api.fireMoment(widget.tournament.id, m.id);
      return true;
    });
    if (mounted) setState(() => _busy = null);
    if (ok != null && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('“${m.title}” is live on the watch page')));
      await _load();
    }
  }

  Future<void> _settle(GameMoment m) async {
    final pick = await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(
        title: Text('Settle: ${m.title}'),
        children: [
          for (final (id, text) in m.options) SimpleDialogOption(onPressed: () => Navigator.pop(c, id), child: Text(text)),
        ],
      ),
    );
    if (pick == null || !mounted) return;
    final ok = await guarded(context, () async {
      await widget.api.settleMoment(widget.tournament.id, m.id, pick);
      return true;
    });
    if (ok != null && mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Settled: viewers who called it are told')));
  }

  @override
  Widget build(BuildContext context) {
    final list = _list;
    final theme = Theme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Games on the watch page', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('Fire one now for everyone watching. Viewer- and stream-clock games also run by themselves.', style: theme.textTheme.bodySmall),
          const SizedBox(height: 8),
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          if (list == null && _error == null) const LinearProgressIndicator(),
          if (list != null && list.isEmpty)
            const InfoBanner(icon: Icons.info_outline, text: 'No games yet. Add a quiz, poll, prediction or wheel in the web Studio.'),
          if (list != null)
            Flexible(
              child: ListView(shrinkWrap: true, children: [
                for (final m in list.where((m) => m.enabled))
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(switch (m.type) { 'spin' => Icons.casino, 'poll' => Icons.bar_chart, 'prediction' => Icons.psychology, _ => Icons.quiz }),
                    title: Text(m.title),
                    subtitle: Text('${m.typeLabel} · ${m.running ? 'running now' : m.clockLabel}'),
                    trailing: Wrap(spacing: 6, children: [
                      if (m.type == 'prediction') OutlinedButton(onPressed: () => _settle(m), child: const Text('Settle')),
                      FilledButton(
                        onPressed: m.running || _busy != null ? null : () => _fire(m),
                        child: _busy == m.id ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : Text(m.running ? 'Running' : 'Fire'),
                      ),
                    ]),
                  ),
              ]),
            ),
          const SizedBox(height: 8),
          SelectableText('Set up games: ${widget.serverUrl}/studio/${widget.tournament.id}', style: theme.textTheme.bodySmall),
        ]),
      ),
    );
  }
}
