import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// QR posters / codes that let volunteers join without an account. One code per role;
/// print it, show it full screen on this phone, or share the link in a WhatsApp group.
class JoinCodesScreen extends StatefulWidget {
  const JoinCodesScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<JoinCodesScreen> createState() => _JoinCodesScreenState();
}

class _JoinCodesScreenState extends State<JoinCodesScreen> {
  late final ApiClient _api = widget.session.api();
  List<JoinCode>? _codes;
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
      final c = await _api.joinCodes(_tid);
      if (!mounted) return;
      setState(() {
        _codes = c;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _create() async {
    var role = TournamentRole.camera;
    int? hours;
    final label = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('New join code'),
          content: SizedBox(
            width: 400,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              SegmentedButton<TournamentRole>(
                segments: [for (final r in guestRoles) ButtonSegment(value: r, label: Text(_roleShort(r)), icon: Icon(_roleIcon(r)))],
                selected: {role},
                onSelectionChanged: (s) => setLocal(() => role = s.first),
              ),
              const SizedBox(height: 12),
              TextField(controller: label, decoration: const InputDecoration(labelText: 'Label (optional)', hintText: 'Back nine cameras')),
              const SizedBox(height: 12),
              DropdownButtonFormField<int?>(
                initialValue: hours,
                decoration: const InputDecoration(labelText: 'Valid for'),
                items: const [
                  DropdownMenuItem(value: null, child: Text('Until revoked')),
                  DropdownMenuItem(value: 12, child: Text('12 hours')),
                  DropdownMenuItem(value: 24, child: Text('1 day')),
                  DropdownMenuItem(value: 72, child: Text('3 days')),
                  DropdownMenuItem(value: 168, child: Text('1 week')),
                ],
                onChanged: (v) => setLocal(() => hours = v),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
          ],
        ),
      ),
    );
    final text = label.text.trim();
    label.dispose();
    if (ok != true || !mounted) return;
    await guarded(context, () => _api.createJoinCode(_tid, role, label: text, expiresInHours: hours));
    await _load();
  }

  Future<void> _revoke(JoinCode c) async {
    final ok = await confirm(context,
        title: 'Revoke ${c.display}?',
        message: 'Nobody new can join with it. People who already joined stay connected until their pass expires.',
        action: 'Revoke',
        destructive: true);
    if (!ok || !mounted) return;
    await guarded(context, () => _api.revokeJoinCode(_tid, c.code));
    await _load();
  }

  void _share(JoinCode c) {
    final t = widget.tournament;
    SharePlus.instance.share(ShareParams(
      subject: 'Join ${t.name} as ${c.role.label.toLowerCase()}',
      text: 'You’re helping with ${t.name} as ${c.role.label.toLowerCase()}.\n\n'
          '1. Install CoGolfer Live.\n2. Open this link or tap “Join” and enter code ${c.display}:\n${c.joinUrl}',
    ));
  }

  void _fullScreen(JoinCode c) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => Scaffold(
        backgroundColor: Colors.white,
        appBar: AppBar(backgroundColor: Colors.white, foregroundColor: Colors.black, title: Text('${widget.tournament.name} · ${c.role.label}')),
        body: SafeArea(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Flexible(child: AspectRatio(aspectRatio: 1, child: AuthImage(api: _api, path: c.qrUrl))),
                const SizedBox(height: 16),
                Text(c.display, style: const TextStyle(color: Colors.black, fontSize: 40, fontWeight: FontWeight.w800, letterSpacing: 6)),
                const SizedBox(height: 8),
                Text('Scan with the CoGolfer Live app (Join > Scan QR)', style: TextStyle(color: Colors.grey.shade800)),
              ]),
            ),
          ),
        ),
      ),
    ));
  }

  static String _roleShort(TournamentRole r) => switch (r) {
        TournamentRole.camera => 'Camera',
        TournamentRole.scorer => 'Scorer',
        TournamentRole.commentator => 'Commentary',
        _ => r.label,
      };

  static IconData _roleIcon(TournamentRole r) => switch (r) {
        TournamentRole.camera => Icons.videocam,
        TournamentRole.scorer => Icons.scoreboard,
        TournamentRole.commentator => Icons.mic,
        _ => Icons.person,
      };

  @override
  Widget build(BuildContext context) {
    final codes = _codes;
    return Scaffold(
      appBar: AppBar(title: const Text('Join codes')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _create, icon: const Icon(Icons.add), label: const Text('New code')),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          if (codes == null && _error == null) const LinearProgressIndicator(),
          if (codes != null && codes.isEmpty)
            const InfoBanner(
              icon: Icons.info_outline,
              text: 'Create one code per role (e.g. one for all camera phones). Print the QR poster or share the link. '
                  'Volunteers scan it, type their name and are ready: no accounts, no passwords.',
            ),
          for (final c in codes ?? const <JoinCode>[])
            Card(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  GestureDetector(
                    onTap: () => _fullScreen(c),
                    child: Container(
                      width: 110,
                      height: 110,
                      color: Colors.white,
                      padding: const EdgeInsets.all(4),
                      child: AuthImage(api: _api, path: c.qrUrl),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Icon(_roleIcon(c.role), size: 18),
                        const SizedBox(width: 6),
                        Text(c.role.label, style: Theme.of(context).textTheme.titleSmall),
                      ]),
                      if (c.label != null) Text(c.label!, style: Theme.of(context).textTheme.bodySmall),
                      const SizedBox(height: 4),
                      SelectableText(c.display, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: 3)),
                      Text(
                        '${c.uses} joined'
                        '${c.expiresAt != null ? ' · until ${TimeOfDay.fromDateTime(c.expiresAt!.toLocal()).format(context)} ${c.expiresAt!.toLocal().day}/${c.expiresAt!.toLocal().month}' : ''}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: 6),
                      Wrap(spacing: 4, children: [
                        IconButton(tooltip: 'Show full screen', onPressed: () => _fullScreen(c), icon: const Icon(Icons.fullscreen)),
                        IconButton(tooltip: 'Share invite', onPressed: () => _share(c), icon: const Icon(Icons.share)),
                        IconButton(tooltip: 'Copy link', onPressed: () => copyText(context, c.joinUrl, 'Link'), icon: const Icon(Icons.link)),
                        IconButton(tooltip: 'Revoke', onPressed: () => _revoke(c), icon: const Icon(Icons.block)),
                      ]),
                    ]),
                  ),
                ]),
              ),
            ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}
