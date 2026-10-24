import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../ui/widgets.dart';
import 'control_room.dart';

/// Broadcast graphics: score bug, leaderboard, hole card, player lower third.
/// Changes reach the on-air overlay in about a second.
class GraphicsSheet extends StatefulWidget {
  const GraphicsSheet({super.key, required this.room});
  final ControlRoom room;

  @override
  State<GraphicsSheet> createState() => _GraphicsSheetState();
}

class _GraphicsSheetState extends State<GraphicsSheet> {
  String? _playerId;
  int? _hole;
  final _title = TextEditingController();
  final _subtitle = TextEditingController();

  ControlRoom get room => widget.room;

  @override
  void initState() {
    super.initState();
    _playerId = room.graphics.lowerThirdPlayerId;
    _hole = room.graphics.holeCardHole ?? room.programme?.hole;
  }

  @override
  void dispose() {
    _title.dispose();
    _subtitle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: room,
      builder: (context, _) {
        final g = room.graphics;
        final rows = room.leaderboard;
        final categories = {for (final r in rows) if (r.category != null && r.category!.isNotEmpty) r.category!}.toList()..sort();
        final small = Theme.of(context).textTheme.bodySmall;
        return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
          Text('Graphics', style: Theme.of(context).textTheme.titleLarge),
          if (room.engine.warnings.any((w) => w.contains('Browser Source')))
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: InfoBanner(icon: Icons.warning_amber, text: 'This OBS has no Browser Source, so graphics cannot appear on air. Install OBS from obsproject.com.', error: true),
            ),
          if (g.questionVisible)
            Card(
              color: Broadcast.course,
              child: ListTile(
                leading: const Icon(Icons.forum, color: Colors.white),
                title: Text('Viewer question on air: ${g.questionAuthor}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                subtitle: Text(g.questionText, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70)),
                trailing: FilledButton(onPressed: () => room.setGraphics({'question': {'visible': false}}), child: const Text('Take off')),
              ),
            ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Score bug'),
            subtitle: const Text('Tournament name, leader and current hole, top-left'),
            value: g.scoreBugVisible,
            onChanged: (v) => room.setGraphics({'scoreBug': {'visible': v}}),
          ),
          const Divider(),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Leaderboard'),
            subtitle: Text('Top ${g.leaderboardSize}${g.leaderboardCategory != null ? ' · ${g.leaderboardCategory}' : ''}'),
            value: g.leaderboardVisible,
            onChanged: (v) => room.setGraphics({'leaderboard': {'visible': v}}),
          ),
          Row(children: [
            Text('Rows', style: small),
            Expanded(
              child: _LiveSlider(
                value: g.leaderboardSize.toDouble(),
                min: 3,
                max: 15,
                divisions: 12,
                label: (v) => '${v.round()}',
                onEnd: (v) => room.setGraphics({'leaderboard': {'size': v.round()}}),
              ),
            ),
            if (categories.isNotEmpty)
              DropdownButton<String?>(
                value: categories.contains(g.leaderboardCategory) ? g.leaderboardCategory : null,
                hint: const Text('All'),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('All')),
                  for (final c in categories) DropdownMenuItem<String?>(value: c, child: Text(c)),
                ],
                onChanged: (v) => room.setGraphics({'leaderboard': {'category': v}}),
              ),
          ]),
          const Divider(),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Hole card on camera change'),
            subtitle: Text('Shows hole, par and field average for ${g.holeCardAuto ? 'a few seconds whenever you cut to another hole' : '—'}'),
            value: g.holeCardAuto,
            onChanged: (v) => room.setGraphics({'holeCard': {'auto': v}}),
          ),
          Row(children: [
            DropdownButton<int>(
              value: _hole,
              hint: const Text('Hole'),
              items: [for (var h = 1; h <= 18; h++) DropdownMenuItem(value: h, child: Text('Hole $h'))],
              onChanged: (v) => setState(() => _hole = v),
            ),
            const SizedBox(width: 12),
            FilledButton.tonal(
              onPressed: _hole == null ? null : () => room.setGraphics({'holeCard': {'visible': true, 'hole': _hole}}),
              child: const Text('Show now'),
            ),
            const SizedBox(width: 8),
            if (g.holeCardVisible) TextButton(onPressed: () => room.setGraphics({'holeCard': {'visible': false}}), child: const Text('Hide')),
          ]),
          const Divider(),
          Row(children: [
            Expanded(child: Text('Lower third', style: Theme.of(context).textTheme.titleMedium)),
            if (g.lowerThirdVisible) const StatusPill(label: 'ON AIR', color: Broadcast.onAir, dense: true),
          ]),
          const SizedBox(height: 8),
          DropdownButtonFormField<String?>(
            initialValue: rows.any((r) => r.playerId == _playerId) ? _playerId : null,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'Player (name, position, score)'),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('Custom text below')),
              for (final r in rows) DropdownMenuItem<String?>(value: r.playerId, child: Text('${r.position.isEmpty ? '–' : r.position}  ${r.name}  ${r.toParText}')),
            ],
            onChanged: (v) => setState(() => _playerId = v),
          ),
          if (_playerId == null) ...[
            const SizedBox(height: 8),
            TextField(controller: _title, maxLength: 60, decoration: const InputDecoration(labelText: 'Title', hintText: 'Rohan Mehta')),
            TextField(controller: _subtitle, maxLength: 80, decoration: const InputDecoration(labelText: 'Subtitle', hintText: 'Club captain · Commentary')),
          ],
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: Broadcast.onAir),
                onPressed: () => room.setGraphics({
                  'lowerThird': _playerId != null
                      ? {'visible': true, 'playerId': _playerId}
                      : {'visible': true, 'playerId': null, 'title': _title.text.trim(), 'subtitle': _subtitle.text.trim()},
                }),
                icon: const Icon(Icons.subtitles),
                label: const Text('Show'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton(
                onPressed: g.lowerThirdVisible ? () => room.setGraphics({'lowerThird': {'visible': false}}) : null,
                child: const Text('Hide'),
              ),
            ),
          ]),
        ]);
      },
    );
  }
}

/// Programme audio: course (camera) sound, per-camera trims, commentary, ducking and delay.
class AudioSheet extends StatelessWidget {
  const AudioSheet({super.key, required this.room});
  final ControlRoom room;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: room,
      builder: (context, _) {
        final a = room.audio;
        final small = Theme.of(context).textTheme.bodySmall;
        return ListView(padding: const EdgeInsets.fromLTRB(16, 0, 16, 24), children: [
          Text('Audio', style: Theme.of(context).textTheme.titleLarge),
          if (!room.metersFresh) Text('Level meters appear when the broadcast engine is connected.', style: small),
          const SizedBox(height: 8),
          _Fader(
            label: 'Commentary',
            db: a.commentaryDb,
            muted: a.commentaryMuted,
            meter: room.commentators.map((c) => room.meterFor(c.obsInput)).whereType<double>().fold<double?>(null, (m, v) => m == null || v > m ? v : m),
            onDb: (v) => room.setAudio({'commentaryDb': v}),
            onMute: (v) => room.setAudio({'commentaryMuted': v}),
          ),
          for (final c in room.commentators)
            Padding(
              padding: const EdgeInsets.only(left: 12, bottom: 4),
              child: Row(children: [
                Icon(Icons.circle, size: 10, color: c.online ? Broadcast.preview : Broadcast.offline),
                const SizedBox(width: 6),
                Expanded(child: Text(c.name, style: small)),
                SizedBox(width: 120, child: LevelMeter(db: room.meterFor(c.obsInput))),
              ]),
            ),
          if (room.commentators.isEmpty) Padding(padding: const EdgeInsets.only(left: 12), child: Text('No commentators yet. Share a commentator join code.', style: small)),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('Duck course sound under commentary'),
            subtitle: const Text('Lowers camera audio automatically while the commentator talks'),
            value: a.ducking,
            onChanged: (v) => room.setAudio({'ducking': v}),
          ),
          Row(children: [
            Text('Commentary delay', style: small),
            Expanded(
              child: _LiveSlider(
                value: a.commentaryDelayMs.toDouble(),
                min: 0,
                max: 2000,
                divisions: 40,
                label: (v) => '${v.round()} ms',
                onEnd: (v) => room.setAudio({'commentaryDelayMs': v.round()}),
              ),
            ),
            SizedBox(width: 64, child: Text('${a.commentaryDelayMs} ms', style: small, textAlign: TextAlign.end)),
          ]),
          Text('Raise the delay if the commentator’s voice is ahead of the picture.', style: small),
          const Divider(height: 28),
          _Fader(
            label: 'Course sound (all cameras)',
            db: a.courseDb,
            muted: a.courseMuted,
            meter: room.programme == null ? null : room.meterFor(ControlRoom.feedInput(room.programme!)),
            onDb: (v) => room.setAudio({'courseDb': v}),
            onMute: (v) => room.setAudio({'courseMuted': v}),
          ),
          const SizedBox(height: 4),
          for (final cam in room.cameras)
            _Fader(
              label: '${cam.name}${room.engine.programmeCameraId == cam.id ? '  · ON AIR' : ''}',
              dense: true,
              db: a.camera(cam.id).db,
              min: -20,
              muted: a.camera(cam.id).muted,
              meter: room.meterFor(ControlRoom.feedInput(cam)),
              onDb: (v) => room.setAudio({'cameras': {cam.id: {'db': v}}}),
              onMute: (v) => room.setAudio({'cameras': {cam.id: {'muted': v}}}),
            ),
        ]);
      },
    );
  }
}

class _Fader extends StatelessWidget {
  const _Fader({required this.label, required this.db, required this.muted, required this.meter, required this.onDb, required this.onMute, this.min = -40, this.dense = false});
  final String label;
  final double db;
  final bool muted;
  final double? meter;
  final ValueChanged<double> onDb;
  final ValueChanged<bool> onMute;
  final double min;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.symmetric(vertical: dense ? 0 : 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Text(label, style: dense ? Theme.of(context).textTheme.bodyMedium : Theme.of(context).textTheme.titleSmall)),
          Text('${db >= 0 ? '+' : ''}${db.toStringAsFixed(0)} dB', style: Theme.of(context).textTheme.bodySmall),
          IconButton(
            tooltip: muted ? 'Unmute' : 'Mute',
            onPressed: () => onMute(!muted),
            icon: Icon(muted ? Icons.volume_off : Icons.volume_up, color: muted ? Broadcast.onAir : null),
          ),
        ]),
        Row(children: [
          Expanded(
            child: _LiveSlider(value: db.clamp(min, 6.0), min: min, max: 6, divisions: (6 - min).round(), label: (v) => '${v.round()} dB', onEnd: onDb),
          ),
          SizedBox(width: 90, child: LevelMeter(db: muted ? null : meter)),
        ]),
      ]),
    );
  }
}

/// Slider that moves freely while dragging and only sends the value when released.
class _LiveSlider extends StatefulWidget {
  const _LiveSlider({required this.value, required this.min, required this.max, required this.divisions, required this.label, required this.onEnd});
  final double value;
  final double min;
  final double max;
  final int divisions;
  final String Function(double) label;
  final ValueChanged<double> onEnd;

  @override
  State<_LiveSlider> createState() => _LiveSliderState();
}

class _LiveSliderState extends State<_LiveSlider> {
  double? _drag;

  @override
  Widget build(BuildContext context) {
    final v = (_drag ?? widget.value).clamp(widget.min, widget.max);
    return Slider(
      value: v,
      min: widget.min,
      max: widget.max,
      divisions: widget.divisions,
      label: widget.label(v),
      onChanged: (x) => setState(() => _drag = x),
      onChangeEnd: (x) {
        setState(() => _drag = null);
        widget.onEnd(x);
      },
    );
  }
}

/// Horizontal peak meter, -60..0 dBFS. Null = no signal / unknown.
class LevelMeter extends StatelessWidget {
  const LevelMeter({super.key, required this.db});
  final double? db;

  @override
  Widget build(BuildContext context) {
    final d = db;
    final f = d == null ? 0.0 : ((d + 60) / 60).clamp(0.0, 1.0);
    final color = d == null ? Colors.white24 : (d > -6 ? Broadcast.onAir : (d > -18 ? Broadcast.warning : Broadcast.preview));
    return ClipRRect(
      borderRadius: BorderRadius.circular(3),
      child: LinearProgressIndicator(value: f, minHeight: 8, backgroundColor: Colors.white10, color: color),
    );
  }
}
