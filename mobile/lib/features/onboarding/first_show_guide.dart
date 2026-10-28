import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import '../director/control_room_screen.dart';
import '../tournament/invite_card.dart';

/// The kinds of event offered in step 1 (same ids as the server's /api/event-types).
const eventTypeChoices = <(String, String, IconData)>[
  ('golf', 'Golf', Icons.golf_course),
  ('cricket', 'Cricket', Icons.sports_cricket),
  ('football', 'Football', Icons.sports_soccer),
  ('wedding', 'Wedding', Icons.favorite_outline),
  ('concert', 'Concert', Icons.music_note),
  ('conference', 'Conference', Icons.co_present),
  ('other', 'Other', Icons.live_tv),
];

/// First show in three steps (onboarding P1-5), opened when an organisation has no events:
///  1. name and kind of event  2. where to stream  3. add cameras, then into the control room.
class FirstShowGuide extends StatefulWidget {
  const FirstShowGuide({super.key, required this.session, required this.org, required this.info});
  final Session session;
  final OrgMembership org;
  final ServerInfo info;

  @override
  State<FirstShowGuide> createState() => _FirstShowGuideState();
}

enum _Dest { golive, myYoutube, key }

class _FirstShowGuideState extends State<FirstShowGuide> {
  late final ApiClient _api = widget.session.api();
  final _name = TextEditingController();
  final _key = TextEditingController();
  int _step = 0;
  String _type = 'golf';
  late _Dest _dest = widget.info.goliveChannel ? _Dest.golive : (widget.info.youtube ? _Dest.myYoutube : _Dest.key);
  Tournament? _event;
  YoutubeState _youtube = const YoutubeState();
  List<Invite> _invites = const [];
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _key.dispose();
    _api.close();
    super.dispose();
  }

  Future<void> _do(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Step 1 → creates the event (Cloud mode, codes made by the server).
  Future<void> _createEvent() => _do(() async {
        final name = _name.text.trim();
        if (name.isEmpty) {
          setState(() => _error = 'Give your event a name, like “Sunday Cup” or “Ananya & Rohan”.');
          return;
        }
        final t = _event ??
            await _api.createTournament(widget.org.id,
                name: name, eventType: _type, mode: widget.info.cloudProduction ? ProductionMode.cloud : null);
        final s = await _api.tournamentState(t.id);
        if (!mounted) return;
        setState(() {
          _event = t.copyWith(role: widget.org.role);
          _youtube = YoutubeState.fromJson(s['youtube'] as Map<String, dynamic>?);
          if (_youtube.source == YoutubeSource.org && _youtube.connected) _dest = _Dest.myYoutube;
          _step = 1;
        });
      });

  /// Step 2 → applies the destination, then shows the camera invites.
  Future<void> _applyDestination() => _do(() async {
        final t = _event!;
        switch (_dest) {
          case _Dest.golive:
            _youtube = await _api.setYoutubeSource(t.id, YoutubeSource.golive);
          case _Dest.myYoutube:
            _youtube = await _api.setYoutubeSource(t.id, YoutubeSource.org);
            if (!_youtube.connected) {
              setState(() => _error = 'Connect your YouTube channel first (button above), then tap Next.');
              return;
            }
          case _Dest.key:
            final k = _key.text.trim();
            if (k.isEmpty) {
              setState(() => _error = 'Paste the stream key from YouTube Studio (Create > Go live > Stream).');
              return;
            }
            _youtube = await _api.setYoutubeKey(t.id, streamKey: k);
        }
        final inv = await _api.invites(t.id);
        if (mounted) {
          setState(() {
            _invites = inv;
            _step = 2;
          });
        }
      });

  Future<void> _connectYoutube() => _do(() async {
        final url = await _api.youtubeConnectUrl(widget.org.id);
        await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      });

  Future<void> _checkYoutube() => _do(() async {
        final s = await _api.tournamentState(_event!.id);
        if (mounted) setState(() => _youtube = YoutubeState.fromJson(s['youtube'] as Map<String, dynamic>?));
      });

  void _toControlRoom() {
    final t = _event!;
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => ControlRoomScreen(session: widget.session, tournament: t)));
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Your first show')),
      body: SafeArea(
        child: Column(children: [
          LinearProgressIndicator(value: (_step + 1) / 3),
          Expanded(
            child: ListView(padding: const EdgeInsets.all(20), children: [
              Text('Step ${_step + 1} of 3', style: theme.textTheme.labelLarge),
              const SizedBox(height: 4),
              Text(const ['What are you streaming?', 'Where should it go live?', 'Add your cameras'][_step], style: theme.textTheme.headlineSmall),
              const SizedBox(height: 16),
              ...switch (_step) {
                0 => _stepEvent(theme),
                1 => _stepDestination(theme),
                _ => _stepCameras(theme),
              },
              if (_error != null) ...[const SizedBox(height: 16), InfoBanner(icon: Icons.error_outline, text: _error!, error: true)],
            ]),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
            child: Row(children: [
              if (_step == 1) TextButton(onPressed: _busy ? null : () => setState(() => _step = 0), child: const Text('Back')),
              const Spacer(),
              FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size(160, 52)),
                onPressed: _busy
                    ? null
                    : switch (_step) {
                        0 => _createEvent,
                        1 => _applyDestination,
                        _ => _toControlRoom,
                      },
                child: _busy
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(const ['Next', 'Next', 'Open control room'][_step]),
              ),
            ]),
          ),
        ]),
      ),
    );
  }

  List<Widget> _stepEvent(ThemeData theme) => [
        TextField(
          controller: _name,
          autofocus: true,
          enabled: _event == null,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(labelText: 'Event name', hintText: 'Sunday Cup, Ananya & Rohan, Annual Day…'),
          onSubmitted: (_) => _createEvent(),
        ),
        const SizedBox(height: 16),
        Text('Kind of event', style: theme.textTheme.titleSmall),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          for (final (id, label, icon) in eventTypeChoices)
            ChoiceChip(
              avatar: Icon(icon, size: 18),
              label: Text(label),
              selected: _type == id,
              onSelected: _event != null ? null : (_) => setState(() => _type = id),
            ),
        ]),
        const SizedBox(height: 8),
        Text('This sets the captions: a wedding shows names, a conference shows speaker titles, golf shows holes and scores.', style: theme.textTheme.bodySmall),
      ];

  List<Widget> _stepDestination(ThemeData theme) => [
        if (widget.info.goliveChannel)
          _DestTile(
            selected: _dest == _Dest.golive,
            icon: Icons.bolt,
            title: 'Go Live channel (instant)',
            text: 'Nothing to set up. Streams unlisted on our YouTube channel; share your watch page link.',
            onTap: () => setState(() => _dest = _Dest.golive),
          ),
        if (widget.info.youtube)
          _DestTile(
            selected: _dest == _Dest.myYoutube,
            icon: Icons.smart_display,
            title: 'My YouTube channel',
            text: _youtube.source == YoutubeSource.org && _youtube.connected
                ? 'Connected: ${_youtube.channelTitle ?? ''}'
                : 'Sign in with Google once. Your channel needs live streaming switched on.',
            onTap: () => setState(() => _dest = _Dest.myYoutube),
            child: _dest == _Dest.myYoutube && !(_youtube.source == YoutubeSource.org && _youtube.connected)
                ? Wrap(spacing: 8, children: [
                    if (widget.org.isOwner) OutlinedButton(onPressed: _busy ? null : _connectYoutube, child: const Text('Connect YouTube')),
                    TextButton(onPressed: _busy ? null : _checkYoutube, child: const Text('I have connected it')),
                    if (!widget.org.isOwner) Text('Ask the organisation owner to connect it.', style: theme.textTheme.bodySmall),
                  ])
                : null,
          ),
        _DestTile(
          selected: _dest == _Dest.key,
          icon: Icons.key,
          title: 'Paste a stream key',
          text: 'From YouTube Studio: Create > Go live > Stream > Stream key.',
          onTap: () => setState(() => _dest = _Dest.key),
          child: _dest == _Dest.key
              ? TextField(controller: _key, autocorrect: false, decoration: const InputDecoration(labelText: 'Stream key'))
              : null,
        ),
        const SizedBox(height: 8),
        Text('You can add Facebook, Instagram and more channels later on the event screen.', style: theme.textTheme.bodySmall),
      ];

  List<Widget> _stepCameras(ThemeData theme) => [
        Text('Send the camera link to each phone that will film. Volunteers need no account.', style: theme.textTheme.bodyMedium),
        const SizedBox(height: 12),
        InviteCard(api: _api, eventName: _event!.name, invites: _invites),
        const SizedBox(height: 12),
        Text('Cameras appear in the control room as they join. Then tap Start show, and Go live.', style: theme.textTheme.bodySmall),
      ];
}

class _DestTile extends StatelessWidget {
  const _DestTile({required this.selected, required this.icon, required this.title, required this.text, required this.onTap, this.child});
  final bool selected;
  final IconData icon;
  final String title;
  final String text;
  final VoidCallback onTap;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: selected ? scheme.primary : scheme.outlineVariant, width: selected ? 2 : 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Icon(icon, color: selected ? scheme.primary : null),
              const SizedBox(width: 10),
              Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
              Icon(selected ? Icons.radio_button_checked : Icons.radio_button_off, color: selected ? scheme.primary : null),
            ]),
            const SizedBox(height: 4),
            Text(text, style: Theme.of(context).textTheme.bodySmall),
            if (child != null) ...[const SizedBox(height: 10), child!],
          ]),
        ),
      ),
    );
  }
}
