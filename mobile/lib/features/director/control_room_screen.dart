import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import '../camera/camera_setup_screen.dart' show positions;
import '../chat/chat_panel.dart';
import '../clips/clips_screen.dart';
import '../org/billing_screen.dart';
import 'camera_tile.dart';
import 'control_room.dart';
import 'games_sheet.dart';
import 'production_sheets.dart';
import 'whep_view.dart';

/// Landscape-first broadcast control room. On tablets: monitors left, multiview right.
/// On phones: monitors on top, multiview below.
class ControlRoomScreen extends StatefulWidget {
  const ControlRoomScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<ControlRoomScreen> createState() => _ControlRoomScreenState();
}

class _ControlRoomScreenState extends State<ControlRoomScreen> {
  late final ControlRoom _room = ControlRoom(session: widget.session, tournament: widget.tournament)..start();
  int _lastAlertCount = 0;

  @override
  void initState() {
    super.initState();
    _room.addListener(_showNewAlerts);
  }

  @override
  void dispose() {
    _room.removeListener(_showNewAlerts);
    _room.dispose();
    super.dispose();
  }

  void _showNewAlerts() {
    if (_room.alerts.length > _lastAlertCount && mounted) {
      final a = _room.alerts.first;
      if (a.level != 'info') {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(
            content: Text(a.message),
            backgroundColor: a.level == 'error' ? Broadcast.onAir : Colors.orange.shade800,
            duration: const Duration(seconds: 4),
          ));
      }
    }
    _lastAlertCount = _room.alerts.length;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0B0E10),
      appBar: AppBar(
        backgroundColor: Broadcast.panel,
        foregroundColor: Colors.white,
        titleSpacing: 8,
        title: ListenableBuilder(
          listenable: _room,
          builder: (_, _) => Text(_room.tournament.name, overflow: TextOverflow.ellipsis),
        ),
        actions: [
          IconButton(
            tooltip: 'Alerts',
            icon: const Icon(Icons.notifications_outlined),
            onPressed: () => _showAlerts(context),
          ),
          SignOutButton(session: widget.session),
        ],
      ),
      body: SafeArea(
        child: ListenableBuilder(
          listenable: _room,
          builder: (context, _) {
            if (!_room.snapshotLoaded) {
              return Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const CircularProgressIndicator(),
                  const SizedBox(height: 12),
                  Text(
                    _room.link.state.value == LinkState.reconnecting ? 'Reconnecting to server…' : 'Connecting to control room…',
                    style: const TextStyle(color: Colors.white70),
                  ),
                ]),
              );
            }
            return LayoutBuilder(builder: (context, c) {
              final wide = c.maxWidth >= 900 && c.maxWidth > c.maxHeight;
              return Column(children: [
                _StatusBar(room: _room, onGoLive: _goLive, onCredits: _openCredits),
                _ToolsRow(
                  room: _room,
                  onGraphics: () => _sheet((_) => GraphicsSheet(room: _room)),
                  onAudio: () => _sheet((_) => AudioSheet(room: _room)),
                  onClip: () => _saveClip(_room.programme),
                  onClips: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(builder: (_) => ClipsScreen(session: widget.session, tournament: _room.tournament))),
                  onComments: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(builder: (_) => ChatScreen(session: widget.session, tournament: _room.tournament))),
                  onGames: () => _sheet((_) => GamesSheet(api: _room.api, tournament: _room.tournament, serverUrl: widget.session.serverUrl)),
                ),
                Expanded(child: wide ? _wideLayout(c) : _narrowLayout(c)),
              ]);
            });
          },
        ),
      ),
    );
  }

  Widget _monitors({required Axis axis}) {
    final room = _room;
    final token = widget.session.token!;
    final prog = room.programme;
    final pvw = room.preview;
    final children = [
      Expanded(
        child: _Monitor(
          title: 'PREVIEW',
          color: Broadcast.preview,
          subtitle: pvw == null ? 'Tap a camera' : '${pvw.name} · ${pvw.assignment}',
          child: WhepView(url: pvw?.whepUrl, token: token),
          footer: FilledButton.icon(
            style: FilledButton.styleFrom(backgroundColor: Broadcast.onAir, minimumSize: const Size(0, 44)),
            onPressed: room.engine.canSwitch && pvw != null && pvw.status == FeedStatus.live && pvw.id != prog?.id && !room.isPending('take')
                ? room.take
                : null,
            icon: room.isPending('take')
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Icon(Icons.arrow_forward),
            label: const Text('TAKE', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1)),
          ),
        ),
      ),
      const SizedBox(width: 8, height: 8),
      Expanded(
        child: _Monitor(
          title: 'PROGRAMME',
          color: Broadcast.onAir,
          subtitle: room.engine.replayActive
              ? 'REPLAY'
              : room.engine.fallbackActive
              ? 'Fallback scene'
              : (prog == null ? (room.engine.programmeScene ?? 'Not set') : '${prog.name} · ${prog.assignment}'),
          child: WhepView(
            url: room.engine.fallbackActive || room.engine.replayActive ? null : prog?.whepUrl,
            token: token,
            placeholder: room.engine.replayActive
                ? const ColoredBox(
                    color: Color(0xFF3A2A00),
                    child: Center(child: Text('REPLAY ON AIR', style: TextStyle(color: Broadcast.warning, fontSize: 18, fontWeight: FontWeight.w800))),
                  )
                : room.engine.fallbackActive
                ? const ColoredBox(
                    color: Broadcast.course,
                    child: Center(child: Text("We'll be right back", style: TextStyle(color: Colors.white, fontSize: 18))),
                  )
                : null,
          ),
          footer: Row(children: [
            Expanded(
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white, minimumSize: const Size(0, 44)),
                onPressed: room.engine.canSwitch && prog != null && !room.engine.replayActive && !room.isPending('replay')
                    ? () => room.replay(prog)
                    : null,
                onLongPress: room.engine.canSwitch && prog != null && !room.engine.replayActive ? () => _replayMenu(prog) : null,
                icon: room.isPending('replay')
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.replay_10),
                label: const Text('REPLAY'),
              ),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: Colors.white, minimumSize: const Size(0, 44)),
                onPressed: room.engine.canSwitch && !room.engine.fallbackActive ? room.fallback : null,
                icon: const Icon(Icons.shield_outlined),
                label: const Text('FALLBACK'),
              ),
            ),
          ]),
        ),
      ),
    ];
    return axis == Axis.horizontal ? Row(children: children) : Column(children: children);
  }

  Widget _grid({required int columns}) {
    final room = _room;
    if (room.cameras.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No cameras yet.\nShare a camera join code (Tournament > Join codes). Each volunteer scans it, names the camera and taps GO LIVE.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white60),
          ),
        ),
      );
    }
    return GridView.builder(
      padding: const EdgeInsets.all(8),
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: columns,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 16 / 12.5,
      ),
      itemCount: room.cameras.length,
      itemBuilder: (context, i) {
        final cam = room.cameras[i];
        return CameraTile(
          api: room.api,
          camera: cam,
          onAir: room.engine.programmeCameraId == cam.id && !room.engine.fallbackActive && !room.engine.replayActive,
          inPreview: (room.engine.previewCameraId ?? room.localPreviewId) == cam.id,
          canSwitch: room.engine.canSwitch,
          onPreview: () => room.previewCamera(cam),
          onCut: () => room.cut(cam),
          onEdit: () => _cameraMenu(cam),
        );
      },
    );
  }

  Widget _wideLayout(BoxConstraints c) => Row(children: [
        SizedBox(width: c.maxWidth * 0.42, child: Padding(padding: const EdgeInsets.all(8), child: _monitors(axis: Axis.vertical))),
        Expanded(child: _grid(columns: c.maxWidth > 1400 ? 4 : 3)),
      ]);

  Widget _narrowLayout(BoxConstraints c) {
    final landscape = c.maxWidth > c.maxHeight;
    if (landscape) {
      return Row(children: [
        SizedBox(width: c.maxWidth * 0.45, child: Padding(padding: const EdgeInsets.all(6), child: _monitors(axis: Axis.vertical))),
        Expanded(child: _grid(columns: 2)),
      ]);
    }
    return Column(children: [
      SizedBox(height: c.maxWidth * 0.62, child: Padding(padding: const EdgeInsets.all(6), child: _monitors(axis: Axis.horizontal))),
      Expanded(child: _grid(columns: c.maxWidth > 600 ? 3 : 2)),
    ]);
  }

  Future<void> _sheet(WidgetBuilder builder) => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (c) => SizedBox(height: MediaQuery.of(c).size.height * 0.8, child: builder(c)),
      );

  Future<void> _replayMenu(CameraInfo cam) async {
    final choice = await showModalBottomSheet<(int, bool)>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text('Replay · ${cam.name}')),
          for (final (secs, slow, label) in const [(8, false, 'Last 8 seconds'), (15, false, 'Last 15 seconds'), (8, true, 'Last 8 seconds, slow motion'), (15, true, 'Last 15 seconds, slow motion')])
            ListTile(leading: Icon(slow ? Icons.slow_motion_video : Icons.replay), title: Text(label), onTap: () => Navigator.pop(c, (secs, slow))),
        ]),
      ),
    );
    if (choice != null) _room.replay(cam, seconds: choice.$1, slowmo: choice.$2);
  }

  Future<void> _saveClip(CameraInfo? cam) async {
    if (_room.cameras.isEmpty) return;
    final req = await showClipDialog(context, cameras: _room.cameras, initialCameraId: cam?.id ?? _room.engine.programmeCameraId);
    if (req != null) await _room.saveClip(req.cameraId, seconds: req.seconds, title: req.title);
  }

  Future<void> _cameraMenu(CameraInfo cam) async {
    final canSwitch = _room.engine.canSwitch && cam.status == FeedStatus.live;
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(cam.name), subtitle: Text('${cam.assignment} · ${cam.deviceModel ?? cam.platform ?? ''}')),
          ListTile(enabled: canSwitch, leading: const Icon(Icons.replay_10), title: const Text('Replay last 10 s on air'), onTap: () => Navigator.pop(c, 'replay')),
          ListTile(enabled: canSwitch, leading: const Icon(Icons.slow_motion_video), title: const Text('Slow-motion replay'), onTap: () => Navigator.pop(c, 'slowmo')),
          ListTile(leading: const Icon(Icons.content_cut), title: const Text('Save clip (highlight)'), onTap: () => Navigator.pop(c, 'clip')),
          ListTile(leading: const Icon(Icons.edit), title: const Text('Name, hole and position'), onTap: () => Navigator.pop(c, 'edit')),
          ListTile(
            enabled: _room.engine.programmeCameraId != cam.id,
            leading: const Icon(Icons.delete_outline, color: Broadcast.onAir),
            title: const Text('Remove camera'),
            onTap: () => Navigator.pop(c, 'remove'),
          ),
        ]),
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'replay':
        _room.replay(cam);
      case 'slowmo':
        _room.replay(cam, slowmo: true);
      case 'clip':
        await _saveClip(cam);
      case 'edit':
        await _editCamera(cam);
      case 'remove':
        final ok = await confirm(context,
            title: 'Remove ${cam.name}?', message: 'The phone stops streaming. It can join again with a camera code.', action: 'Remove', destructive: true);
        if (ok) await _room.removeCamera(cam);
    }
  }

  /// Go live on YouTube. With a connected channel and no broadcast yet, create it first.
  Future<void> _goLive() async {
    final b = _room.billing;
    if (b.enabled && !b.canGoLive) {
      final buy = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
          title: Text(b.suspended ? 'Club suspended' : 'No live minutes left'),
          content: Text(b.reason ?? 'Buy credits to go live.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Close')),
            if (!b.suspended) FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Buy credits')),
          ],
        ),
      );
      if (buy == true) _openCredits();
      return;
    }
    final yt = _room.youtube;
    if (yt.connected && !yt.hasBroadcast) {
      var privacy = 'unlisted';
      final ok = await showDialog<bool>(
        context: context,
        builder: (c) => StatefulBuilder(
          builder: (c, setLocal) => AlertDialog(
            title: const Text('Create the YouTube broadcast'),
            content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('On ${yt.channelTitle ?? 'your channel'}, titled “${_room.tournament.title}”.'),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'public', label: Text('Public')),
                  ButtonSegment(value: 'unlisted', label: Text('Unlisted')),
                  ButtonSegment(value: 'private', label: Text('Private')),
                ],
                selected: {privacy},
                onSelectionChanged: (s) => setLocal(() => privacy = s.first),
              ),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
              FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create and go live')),
            ],
          ),
        ),
      );
      if (ok != true) return;
      final err = await _room.createBroadcast(privacy: privacy);
      if (err != null) return;
      // The engine receives the new stream key with its config; give it a moment.
      await Future<void>.delayed(const Duration(seconds: 2));
    }
    _room.startYouTube();
  }

  void _openCredits() {
    final t = _room.tournament;
    final org = widget.session.selectedOrg;
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => BillingScreen(
        session: widget.session,
        orgId: t.orgId ?? org?.id ?? '',
        orgName: t.orgName ?? org?.name ?? 'Club',
        isOwner: t.role == TournamentRole.owner,
      ),
    ));
  }

  Future<void> _editCamera(CameraInfo cam) async {
    final name = TextEditingController(text: cam.name);
    int? hole = cam.hole;
    var position = positions.firstWhere((p) => p.toLowerCase() == (cam.position ?? '').toLowerCase(), orElse: () => 'Other');
    String? error;
    await showDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: Text('Camera assignment · ${cam.deviceModel ?? cam.platform ?? ''}'),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Camera name')),
              const SizedBox(height: 12),
              DropdownButtonFormField<int?>(
                initialValue: hole,
                decoration: const InputDecoration(labelText: 'Hole'),
                items: [
                  const DropdownMenuItem<int?>(value: null, child: Text('None')),
                  for (var h = 1; h <= 18; h++) DropdownMenuItem<int?>(value: h, child: Text('Hole $h')),
                ],
                onChanged: (v) => setLocal(() => hole = v),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: position,
                decoration: const InputDecoration(labelText: 'Position'),
                items: [for (final p in positions) DropdownMenuItem(value: p, child: Text(p))],
                onChanged: (v) => setLocal(() => position = v ?? position),
              ),
              if (error != null) ...[
                const SizedBox(height: 12),
                InfoBanner(icon: Icons.error_outline, text: error!, error: true),
              ],
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                final err = await _room.updateCamera(cam, name: name.text.trim(), hole: hole, position: position);
                if (err == null) {
                  if (c.mounted) Navigator.pop(c);
                } else {
                  setLocal(() => error = err);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    name.dispose();
  }

  void _showAlerts(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (c) => ListenableBuilder(
        listenable: _room,
        builder: (c, _) => ListView(
          padding: const EdgeInsets.all(12),
          children: [
            SwitchListTile(
              title: const Text('Auto-fallback'),
              subtitle: const Text('Cut to the fallback scene if the on-air camera drops for 3 seconds'),
              value: _room.tournament.autoFallback,
              onChanged: _room.setAutoFallback,
            ),
            const Divider(),
            if (_room.alerts.isEmpty) const ListTile(title: Text('No alerts')),
            for (final a in _room.alerts)
              ListTile(
                dense: true,
                leading: Icon(
                  a.level == 'error' ? Icons.error : (a.level == 'warning' ? Icons.warning_amber : Icons.info_outline),
                  color: a.level == 'error' ? Broadcast.onAir : (a.level == 'warning' ? Broadcast.warning : null),
                ),
                title: Text(a.message),
                subtitle: Text(TimeOfDay.fromDateTime(a.at).format(c)),
              ),
          ],
        ),
      ),
    );
  }
}

class _Monitor extends StatelessWidget {
  const _Monitor({required this.title, required this.color, required this.subtitle, required this.child, required this.footer});
  final String title;
  final Color color;
  final String subtitle;
  final Widget child;
  final Widget footer;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Broadcast.panel,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color, width: 2),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          color: color,
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          child: Row(children: [
            Text(title, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12, letterSpacing: 1)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(subtitle,
                  overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 12)),
            ),
          ]),
        ),
        Expanded(child: AspectRatio(aspectRatio: 16 / 9, child: child)),
        Padding(padding: const EdgeInsets.all(6), child: footer),
      ]),
    );
  }
}

/// Engine (OBS), YouTube output and ingest server health, always visible.
class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.room, required this.onGoLive, required this.onCredits});
  final ControlRoom room;
  final VoidCallback onGoLive;
  final VoidCallback onCredits;

  @override
  Widget build(BuildContext context) {
    final e = room.engine;
    final s = e.streaming;
    final liveCams = room.cameras.where((c) => c.status == FeedStatus.live).length;
    final p = room.production;
    final cloud = p.mode == ProductionMode.cloud;
    final (engineLabel, engineColor) = !e.connected
        ? (cloud ? 'CLOUD ENGINE ${p.cloudStatus.name.toUpperCase()}' : 'ENGINE OFFLINE', cloud && p.cloudBusy ? Broadcast.warning : Broadcast.onAir)
        : (!e.obsConnected ? ('OBS NOT REACHABLE', Broadcast.onAir) : ('OBS READY', Broadcast.preview));
    final (ytLabel, ytColor) = s.reconnecting
        ? ('YOUTUBE RECONNECTING', Broadcast.warning)
        : (s.active ? ('YOUTUBE LIVE ${s.timecode?.split('.').first ?? ''}', Broadcast.onAir) : ('YOUTUBE OFF', Broadcast.offline));
    return Container(
      color: Broadcast.panel,
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      // The show button is pinned on the right; the status pills scroll beside it.
      child: Row(children: [
        Expanded(
          child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          if (!room.linkConnected) ...[
            const StatusPill(label: 'SERVER RECONNECTING', color: Broadcast.warning, icon: Icons.cloud_off),
            const SizedBox(width: 6),
          ],
          StatusPill(label: engineLabel, color: engineColor, icon: cloud ? Icons.cloud : Icons.memory),
          const SizedBox(width: 6),
          StatusPill(label: ytLabel, color: ytColor, icon: Icons.smart_display),
          for (final o in room.outputs.active)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: StatusPill(
                dense: true,
                label: '${o.platform.label.toUpperCase()} ${switch (o.state) {
                  'live' => 'LIVE',
                  'connecting' => '…',
                  'retrying' => 'RETRYING',
                  _ => 'READY',
                }}',
                color: switch (o.state) {
                  'live' => Broadcast.onAir,
                  'connecting' || 'retrying' => Broadcast.warning,
                  _ => Broadcast.panelHigh,
                },
              ),
            ),
          for (final d in room.outputs.activeDestinations)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: StatusPill(
                dense: true,
                label: '${d.label.toUpperCase()} ${switch (d.state) {
                  'live' => 'LIVE',
                  'connecting' => '…',
                  'retrying' => 'RETRYING',
                  _ => 'READY',
                }}',
                color: switch (d.state) {
                  'live' => Broadcast.onAir,
                  'connecting' || 'retrying' => Broadcast.warning,
                  _ => Broadcast.panelHigh,
                },
              ),
            ),
          if (room.billing.enabled && (room.billing.remainingSeconds != null || room.billing.suspended)) ...[
            const SizedBox(width: 6),
            InkWell(onTap: onCredits, borderRadius: BorderRadius.circular(6), child: _CreditPill(billing: room.billing)),
          ],
          if (room.youtube.hasBroadcast) ...[
            const SizedBox(width: 6),
            Text('YouTube: ${room.youtube.statusLabel}${room.youtube.health != null ? ' · ${room.youtube.health}' : ''}',
                style: const TextStyle(color: Colors.white70, fontSize: 12)),
          ],
          if (s.active) ...[
            const SizedBox(width: 6),
            Text(
              '${formatKbps(s.kbps)}  ·  dropped ${s.skippedFrames ?? 0}/${s.totalFrames ?? 0}'
              '${s.congestion != null ? '  ·  congestion ${(s.congestion! * 100).round()}%' : ''}',
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
          ],
          const SizedBox(width: 6),
          StatusPill(
            label: room.mediaServerReachable ? 'INGEST OK · $liveCams/${room.cameras.length} LIVE' : 'INGEST DOWN',
            color: room.mediaServerReachable ? Broadcast.panelHigh : Broadcast.onAir,
            icon: Icons.sensors,
          ),
          if (e.lastError != null) ...[
            const SizedBox(width: 8),
            Text(e.lastError!, style: const TextStyle(color: Broadcast.warning, fontSize: 12)),
          ],
          for (final w in e.warnings) ...[
            const SizedBox(width: 8),
            Text('⚠ $w', style: const TextStyle(color: Broadcast.warning, fontSize: 12)),
          ],
        ]),
          ),
        ),
        const SizedBox(width: 8),
        _ShowButton(room: room, onGoLive: onGoLive, onStop: () => _confirmStop(context)),
      ]),
    );
  }

  Future<void> _confirmStop(BuildContext context) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('End the YouTube stream?'),
        content: const Text('Viewers will see the broadcast end.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('End stream')),
        ],
      ),
    );
    if (ok == true) room.stopYouTube();
  }
}

/// One button for the whole show (P1-11), always visible at the right of the status bar:
/// Start show → "Starting mixer… 40 s" → "Checking cameras" → Go live → End stream.
class _ShowButton extends StatefulWidget {
  const _ShowButton({required this.room, required this.onGoLive, required this.onStop});
  final ControlRoom room;
  final VoidCallback onGoLive;
  final VoidCallback onStop;

  @override
  State<_ShowButton> createState() => _ShowButtonState();
}

class _ShowButtonState extends State<_ShowButton> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // Redraws the countdown once a second while the mixer starts.
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && _starting) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  ControlRoom get room => widget.room;

  bool get _starting {
    final p = room.production;
    return p.mode == ProductionMode.cloud && !room.engine.canSwitch && (p.cloudBusy || (room.showStartedAt != null && p.cloudStatus != CloudEngineStatus.error && p.cloudStatus != CloudEngineStatus.stopped));
  }

  @override
  Widget build(BuildContext context) {
    final e = room.engine;
    final p = room.production;
    final cloud = p.mode == ProductionMode.cloud;
    const dense = VisualDensity.compact;
    if (e.streaming.active) {
      return OutlinedButton(
        style: OutlinedButton.styleFrom(foregroundColor: Colors.white, visualDensity: dense),
        onPressed: room.isPending('stream.stop') ? null : widget.onStop,
        child: const Text('End stream'),
      );
    }
    if (cloud && !e.canSwitch) {
      if (_starting) {
        final since = room.showStartedAt == null ? 0 : DateTime.now().difference(room.showStartedAt!).inSeconds;
        // A cloud mixer usually takes 40–60 seconds to be ready.
        final left = (50 - since).clamp(5, 50);
        return FilledButton.icon(
          style: FilledButton.styleFrom(visualDensity: dense),
          onPressed: null,
          icon: const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          label: Text(e.connected ? 'Connecting mixer…' : 'Starting mixer… ${left}s'),
        );
      }
      return FilledButton.icon(
        style: FilledButton.styleFrom(backgroundColor: Broadcast.preview, visualDensity: dense),
        onPressed: room.startShow,
        icon: const Icon(Icons.rocket_launch),
        label: const Text('Start show'),
      );
    }
    if (!e.canSwitch) {
      return FilledButton(style: FilledButton.styleFrom(visualDensity: dense), onPressed: null, child: const Text('Engine offline'));
    }
    final liveCams = room.cameras.where((c) => c.status == FeedStatus.live).length;
    if (cloud && liveCams == 0) {
      return FilledButton.icon(
        style: FilledButton.styleFrom(visualDensity: dense),
        onPressed: null,
        icon: const Icon(Icons.videocam_off, size: 18),
        label: const Text('Checking cameras…'),
      );
    }
    return FilledButton.icon(
      style: FilledButton.styleFrom(backgroundColor: Broadcast.onAir, visualDensity: dense),
      onPressed: room.isPending('stream.start') ? null : widget.onGoLive,
      icon: const Icon(Icons.play_arrow),
      label: Text(room.outputs.goLiveLabel),
    );
  }
}

/// Quick production tools under the status bar.
class _ToolsRow extends StatelessWidget {
  const _ToolsRow({
    required this.room,
    required this.onGraphics,
    required this.onAudio,
    required this.onClip,
    required this.onClips,
    required this.onComments,
    required this.onGames,
  });
  final ControlRoom room;
  final VoidCallback onGames;
  final VoidCallback onGraphics;
  final VoidCallback onAudio;
  final VoidCallback onClip;
  final VoidCallback onClips;
  final VoidCallback onComments;

  @override
  Widget build(BuildContext context) {
    final g = room.graphics;
    final working = room.recentClips.where((c) => c.working).length;
    Widget tool(IconData icon, String label, VoidCallback? onTap, {bool active = false}) => Padding(
          padding: const EdgeInsets.only(right: 6),
          child: FilledButton.tonalIcon(
            style: FilledButton.styleFrom(
              visualDensity: VisualDensity.compact,
              backgroundColor: active ? Broadcast.course : Broadcast.panelHigh,
              foregroundColor: Colors.white,
            ),
            onPressed: onTap,
            icon: Icon(icon, size: 18),
            label: Text(label),
          ),
        );
    return Container(
      color: const Color(0xFF101417),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          tool(Icons.layers, g.leaderboardVisible || g.lowerThirdVisible ? 'Graphics •' : 'Graphics', onGraphics,
              active: g.leaderboardVisible || g.lowerThirdVisible || g.holeCardVisible),
          tool(Icons.graphic_eq, room.audio.commentaryMuted || room.audio.courseMuted ? 'Audio (muted)' : 'Audio', onAudio),
          tool(Icons.content_cut, 'Save clip', room.cameras.isEmpty ? null : onClip),
          tool(Icons.video_library, working > 0 ? 'Clips ($working making)' : 'Clips', onClips),
          tool(Icons.forum, 'Comments', onComments, active: g.questionVisible),
          tool(Icons.casino, 'Games', onGames),
          if (room.commentators.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: Row(children: [
                Icon(Icons.mic, size: 16, color: room.commentators.any((c) => c.online) ? Broadcast.onAir : Colors.white38),
                const SizedBox(width: 4),
                Text('${room.commentators.where((c) => c.online).length}/${room.commentators.length} commentary',
                    style: const TextStyle(color: Colors.white70, fontSize: 12)),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// Live time left from the club's credits; red with a countdown in the grace period.
class _CreditPill extends StatelessWidget {
  const _CreditPill({required this.billing});
  final TournamentBilling billing;

  @override
  Widget build(BuildContext context) {
    final b = billing;
    if (b.suspended) return const StatusPill(label: 'CLUB SUSPENDED', color: Broadcast.onAir, icon: Icons.block);
    if (b.graceActive) {
      final s = b.graceSecondsLeft ?? 0;
      return StatusPill(label: 'CREDITS OUT · ENDS IN ${formatDuration(Duration(seconds: s))}', color: Broadcast.onAir, icon: Icons.timer_off);
    }
    final m = b.remainingMinutes ?? 0;
    final free = b.freeSecondsLeft > 0;
    final label = m >= 120 ? '${(m / 60).floor()} H ${m % 60} MIN LEFT' : '$m MIN LEFT';
    return StatusPill(
      label: free ? 'FREE TIME · $label' : 'CREDITS · $label',
      color: b.low ? Broadcast.warning : Broadcast.panelHigh,
      icon: Icons.timer_outlined,
    );
  }
}
