import 'dart:async';

import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import '../chat/chat_panel.dart';
import '../director/whep_view.dart';
import 'whip_publisher.dart';

/// Commentator Mode: watch what is on air (low-latency WebRTC), see the leaderboard, and
/// talk. The microphone goes to the broadcast engine, which mixes it over course audio.
class CommentatorScreen extends StatefulWidget {
  const CommentatorScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<CommentatorScreen> createState() => _CommentatorScreenState();
}

class _CommentatorScreenState extends State<CommentatorScreen> {
  late final ApiClient _api = widget.session.api();
  late final RealtimeLink _link = RealtimeLink(
    serverUrl: widget.session.serverUrl,
    token: widget.session.token!,
    onOpenMessages: () => [
      {'type': 'subscribe', 'tournamentId': widget.tournament.id},
    ],
  );
  StreamSubscription<Map<String, dynamic>>? _sub;
  WhipPublisher? _mic;
  List<CameraInfo> _cameras = const [];
  EngineState _engine = const EngineState();
  List<LeaderboardRow> _board = const [];
  String? _error;
  bool _registering = true;

  @override
  void initState() {
    super.initState();
    _sub = _link.messages.listen(_onMessage);
    _link.state.addListener(_changed);
    _link.connect();
    _register();
  }

  @override
  void dispose() {
    unawaited(CgStreamer.setKeepScreenOn(false).catchError((Object _) {}));
    _mic?.removeListener(_changed);
    _mic?.dispose();
    _sub?.cancel();
    _link.state.removeListener(_changed);
    _link.close();
    _api.close();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _register() async {
    setState(() {
      _registering = true;
      _error = null;
    });
    try {
      final t = await _api.registerCommentator(widget.tournament.id, name: widget.session.displayName, deviceId: await CgStreamer.deviceId());
      if (!mounted) return;
      final mic = WhipPublisher(whipUrl: t.whipUrl, bearer: t.bearer)..addListener(_changed);
      setState(() => _mic = mic);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _registering = false);
    }
  }

  void _onMessage(Map<String, dynamic> m) {
    switch (m['type']) {
      case 'snapshot':
        _cameras = ((m['cameras'] as List?) ?? const []).map((c) => CameraInfo.fromJson(c as Map<String, dynamic>)).toList();
        _engine = EngineState.fromJson(m['engine'] as Map<String, dynamic>?);
        _board = parseLeaderboard(m['leaderboard']);
      case 'cameras':
        _cameras = ((m['cameras'] as List?) ?? const []).map((c) => CameraInfo.fromJson(c as Map<String, dynamic>)).toList();
      case 'engine':
        _engine = EngineState.fromJson(m['engine'] as Map<String, dynamic>?);
      case 'leaderboard':
        _board = parseLeaderboard(m['rows']);
    }
    _changed();
  }

  CameraInfo? get _programme {
    for (final c in _cameras) {
      if (c.id == _engine.programmeCameraId) return c;
    }
    return null;
  }

  Future<void> _toggleLive() async {
    final mic = _mic;
    if (mic == null) return;
    if (mic.active) {
      await mic.stop();
      await CgStreamer.setKeepScreenOn(false).catchError((Object _) {});
    } else {
      await CgStreamer.setKeepScreenOn(true).catchError((Object _) {});
      await mic.start();
    }
  }

  @override
  Widget build(BuildContext context) {
    final mic = _mic;
    final prog = _programme;
    final ios = defaultTargetPlatform == TargetPlatform.iOS;
    return Scaffold(
      backgroundColor: const Color(0xFF0B0E10),
      appBar: AppBar(
        backgroundColor: Broadcast.panel,
        title: Text('Commentary · ${widget.tournament.name}', overflow: TextOverflow.ellipsis),
        actions: [if (widget.session.isGuest) SignOutButton(session: widget.session)],
      ),
      body: SafeArea(
        child: LayoutBuilder(builder: (context, c) {
          final wide = c.maxWidth > 800 && c.maxWidth > c.maxHeight;
          final monitor = Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Container(
              color: _engine.replayActive ? Broadcast.warning : Broadcast.onAir,
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              child: Text(
                _engine.replayActive
                    ? 'REPLAY ON AIR'
                    : _engine.fallbackActive
                        ? 'ON AIR: “back soon” screen'
                        : prog == null
                            ? (_engine.connected ? 'ON AIR: —' : 'Broadcast engine offline')
                            : 'ON AIR: ${prog.name} · ${prog.assignment}',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700),
              ),
            ),
            AspectRatio(
              aspectRatio: 16 / 9,
              child: WhepView(url: _engine.fallbackActive || _engine.replayActive ? null : prog?.whepUrl, token: widget.session.token!),
            ),
          ]);
          final controls = _MicPanel(mic: mic, registering: _registering, error: _error, onRetry: _register, onToggle: _toggleLive, ios: ios);
          final board = _SideTabs(
            board: _MiniBoard(rows: _board),
            chat: ChatPanel(session: widget.session, tournament: widget.tournament),
          );
          if (wide) {
            return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(flex: 3, child: ListView(padding: const EdgeInsets.all(12), children: [monitor, const SizedBox(height: 12), controls])),
              Expanded(flex: 2, child: Padding(padding: const EdgeInsets.all(12), child: board)),
            ]);
          }
          return ListView(padding: const EdgeInsets.all(12), children: [
            monitor,
            const SizedBox(height: 12),
            controls,
            const SizedBox(height: 12),
            SizedBox(height: 480, child: board),
          ]);
        }),
      ),
    );
  }
}

class _MicPanel extends StatelessWidget {
  const _MicPanel({required this.mic, required this.registering, required this.error, required this.onRetry, required this.onToggle, required this.ios});
  final WhipPublisher? mic;
  final bool registering;
  final String? error;
  final VoidCallback onRetry;
  final VoidCallback onToggle;
  final bool ios;

  @override
  Widget build(BuildContext context) {
    final m = mic;
    if (registering) return const Center(child: Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()));
    if (m == null) {
      return Column(children: [
        InfoBanner(icon: Icons.error_outline, text: error ?? 'Could not set up commentary.', error: true),
        const SizedBox(height: 8),
        OutlinedButton(onPressed: onRetry, child: const Text('Try again')),
      ]);
    }
    final (label, color) = switch (m.state) {
      MicState.idle => ('MIC OFF', Broadcast.offline),
      MicState.connecting => ('CONNECTING', Broadcast.warning),
      MicState.live => (m.muted ? 'MUTED' : 'MIC LIVE', m.muted ? Broadcast.warning : Broadcast.onAir),
      MicState.reconnecting => ('RECONNECTING', Broadcast.warning),
      MicState.error => ('RETRYING', Broadcast.warning),
    };
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Broadcast.panel, borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          StatusPill(label: label, color: color, icon: Icons.mic),
          const SizedBox(width: 12),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: m.level,
                minHeight: 10,
                backgroundColor: Colors.white12,
                color: m.level > 0.8 ? Broadcast.onAir : Broadcast.preview,
              ),
            ),
          ),
        ]),
        if (m.error != null && m.state != MicState.live)
          Padding(padding: const EdgeInsets.only(top: 8), child: Text(m.error!, style: const TextStyle(color: Broadcast.warning))),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(
            child: FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: m.active ? Colors.white24 : Broadcast.onAir, minimumSize: const Size(0, 56)),
              onPressed: onToggle,
              icon: Icon(m.active ? Icons.stop : Icons.mic),
              label: Text(m.active ? 'Stop commentary' : 'Start commentary', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            height: 56,
            child: OutlinedButton.icon(
              onPressed: m.active ? () => m.setMuted(!m.muted) : null,
              icon: Icon(m.muted ? Icons.mic_off : Icons.mic_none),
              label: Text(m.muted ? 'Unmute' : 'Mute'),
            ),
          ),
        ]),
        const SizedBox(height: 12),
        Text(
          'Use wired or Bluetooth earphones so the programme sound does not feed back into your mic. '
          'The picture above is about half a second behind the broadcast; your voice is lined up in the mix. '
          '${ios ? 'iPhone: keep this screen open while you talk.' : 'Keep this screen open while you talk.'}',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Colors.white60),
        ),
      ]),
    );
  }
}

class _MiniBoard extends StatelessWidget {
  const _MiniBoard({required this.rows});
  final List<LeaderboardRow> rows;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(color: Broadcast.panel, borderRadius: BorderRadius.circular(12)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const Padding(padding: EdgeInsets.fromLTRB(14, 12, 14, 6), child: Text('LEADERBOARD', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1))),
        Expanded(
          child: rows.isEmpty
              ? const Center(child: Text('No scores yet', style: TextStyle(color: Colors.white54)))
              : ListView(children: [
                  for (final r in rows)
                    ListTile(
                      dense: true,
                      leading: SizedBox(width: 30, child: Text(r.position, style: const TextStyle(fontWeight: FontWeight.w700))),
                      title: Text(r.name),
                      subtitle: r.club == null ? null : Text(r.club!),
                      trailing: Text('${r.toParText}  ${r.thru}', style: TextStyle(fontWeight: FontWeight.w700, color: (r.toPar ?? 0) < 0 ? Broadcast.onAir : null)),
                    ),
                ]),
        ),
      ]),
    );
  }
}

/// Leaderboard and viewer comments side by side in tabs (comments first: questions to read out).
class _SideTabs extends StatelessWidget {
  const _SideTabs({required this.board, required this.chat});
  final Widget board;
  final Widget chat;

  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 2,
        child: Column(children: [
          const TabBar(tabs: [Tab(text: 'Comments'), Tab(text: 'Leaderboard')]),
          const SizedBox(height: 6),
          Expanded(child: TabBarView(children: [chat, board])),
        ]),
      );
}
