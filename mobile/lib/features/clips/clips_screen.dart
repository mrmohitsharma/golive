import 'dart:async';

import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// Highlight clips: each one is rendered twice, 16:9 for YouTube/WhatsApp and 9:16 for
/// Reels/Shorts, with the title burnt in. Share sends a signed link valid for 7 days.
class ClipsScreen extends StatefulWidget {
  const ClipsScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<ClipsScreen> createState() => _ClipsScreenState();
}

class _ClipsScreenState extends State<ClipsScreen> {
  late final ApiClient _api = widget.session.api();
  List<HighlightClip>? _clips;
  String? _error;
  Timer? _poll;

  String get _tid => widget.tournament.id;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final c = await _api.clips(_tid);
      if (!mounted) return;
      setState(() {
        _clips = c;
        _error = null;
      });
      _poll?.cancel();
      // Refresh while clips are still being made (usually 5-20 s each).
      if (c.any((x) => x.working)) _poll = Timer(const Duration(seconds: 3), _load);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _newClip() async {
    final state = await guarded(context, () => _api.tournamentState(_tid));
    if (state == null || !mounted) return;
    final cams = ((state['cameras'] as List?) ?? const []).map((c) => CameraInfo.fromJson(c as Map<String, dynamic>)).toList();
    if (cams.isEmpty) return toast(context, 'No cameras in this tournament yet.');
    final engine = EngineState.fromJson(state['engine'] as Map<String, dynamic>?);
    final req = await showClipDialog(context, cameras: cams, initialCameraId: engine.programmeCameraId);
    if (req == null || !mounted) return;
    await guarded(context, () => _api.createClip(_tid, cameraId: req.cameraId, secondsBack: req.seconds, durationSec: req.seconds, title: req.title));
    await _load();
  }

  Future<void> _share(HighlightClip c, {required bool vertical}) async {
    final links = await guarded(context, () => _api.shareClip(c.id));
    if (links == null) return;
    await SharePlus.instance.share(ShareParams(
      subject: c.headline,
      text: '${c.headline} · ${widget.tournament.name}\n${vertical ? links.verticalUrl : links.landscapeUrl}',
    ));
  }

  Future<void> _play(HighlightClip c, {bool vertical = false}) async {
    final links = await guarded(context, () => _api.shareClip(c.id));
    if (links == null) return;
    await launchUrl(Uri.parse(vertical ? links.verticalUrl : links.landscapeUrl), mode: LaunchMode.externalApplication);
  }

  Future<void> _togglePublic(HighlightClip c) async {
    final r = await guarded(context, () => _api.setClipPublic(c.id, !c.isPublic));
    if (r == null || !mounted) return;
    toast(context, r.isPublic ? 'Shown on the watch page' : 'Hidden from the watch page');
    await _load();
  }

  Future<void> _delete(HighlightClip c) async {
    final ok = await confirm(context, title: 'Delete clip?', message: 'Shared links stop working.', action: 'Delete', destructive: true);
    if (!ok || !mounted) return;
    await guarded(context, () => _api.deleteClip(c.id));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final clips = _clips;
    return Scaffold(
      appBar: AppBar(title: const Text('Clips')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _newClip, icon: const Icon(Icons.content_cut), label: const Text('New clip')),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          if (clips == null && _error == null) const LinearProgressIndicator(),
          if (clips != null && clips.isEmpty)
            const InfoBanner(
              icon: Icons.info_outline,
              text: 'No clips yet. In the control room, long-press a camera > “Save clip” right after a great shot. '
                  'Every camera is recorded for the last hours, so you can clip any of them, on air or not.',
            ),
          for (final c in clips ?? const <HighlightClip>[])
            Card(
              clipBehavior: Clip.antiAlias,
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                SizedBox(
                  width: 140,
                  height: 79,
                  child: c.status == ClipStatus.ready && c.thumbPath != null
                      ? InkWell(onTap: () => _play(c), child: AuthImage(api: _api, path: c.thumbPath!, fit: BoxFit.cover))
                      : ColoredBox(
                          color: Colors.black38,
                          child: Center(
                            child: c.working
                                ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2))
                                : const Icon(Icons.error_outline, color: Broadcast.warning),
                          ),
                        ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 4, 4),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(c.headline.isEmpty ? 'Clip' : c.headline, maxLines: 1, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.titleSmall),
                      Text(
                        [
                          '${c.durationSec}s',
                          if (c.createdAt != null) TimeOfDay.fromDateTime(c.createdAt!.toLocal()).format(context),
                          switch (c.status) {
                            ClipStatus.queued => 'queued',
                            ClipStatus.processing => 'making…',
                            ClipStatus.ready => c.sizeBytes == null ? 'ready' : '${(c.sizeBytes! / 1e6).toStringAsFixed(1)} MB',
                            ClipStatus.failed => 'failed',
                          },
                        ].join(' · '),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      if (c.status == ClipStatus.failed && c.error != null)
                        Text(c.error!, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Broadcast.warning, fontSize: 12)),
                      if (c.status == ClipStatus.ready)
                        Wrap(children: [
                          IconButton(tooltip: 'Play', onPressed: () => _play(c), icon: const Icon(Icons.play_circle_outline)),
                          IconButton(tooltip: 'Share 16:9', onPressed: () => _share(c, vertical: false), icon: const Icon(Icons.crop_landscape)),
                          IconButton(tooltip: 'Share 9:16 (Reels/Shorts)', onPressed: () => _share(c, vertical: true), icon: const Icon(Icons.crop_portrait)),
                          IconButton(
                            tooltip: c.isPublic ? 'On the watch page (tap to hide)' : 'Hidden from the watch page (tap to show)',
                            onPressed: () => _togglePublic(c),
                            icon: Icon(c.isPublic ? Icons.public : Icons.public_off),
                          ),
                          IconButton(tooltip: 'Delete', onPressed: () => _delete(c), icon: const Icon(Icons.delete_outline)),
                        ])
                      else if (c.status == ClipStatus.failed)
                        IconButton(tooltip: 'Delete', onPressed: () => _delete(c), icon: const Icon(Icons.delete_outline)),
                    ]),
                  ),
                ),
              ]),
            ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}

class ClipRequest {
  const ClipRequest(this.cameraId, this.seconds, this.title);
  final String cameraId;
  final int seconds;
  final String? title;
}

/// "Save the last N seconds of this camera": used here and from the control room.
Future<ClipRequest?> showClipDialog(BuildContext context, {required List<CameraInfo> cameras, String? initialCameraId}) async {
  var cameraId = cameras.any((c) => c.id == initialCameraId) ? initialCameraId! : cameras.first.id;
  var seconds = 30;
  final title = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => StatefulBuilder(
      builder: (c, setLocal) => AlertDialog(
        title: const Text('Save clip'),
        content: SizedBox(
          width: 420,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (cameras.length > 1) ...[
              DropdownButtonFormField<String>(
                initialValue: cameraId,
                decoration: const InputDecoration(labelText: 'Camera'),
                items: [for (final cam in cameras) DropdownMenuItem(value: cam.id, child: Text('${cam.name} · ${cam.assignment}'))],
                onChanged: (v) => setLocal(() => cameraId = v ?? cameraId),
              ),
              const SizedBox(height: 12),
            ],
            Text('The last…', style: Theme.of(c).textTheme.titleSmall),
            const SizedBox(height: 6),
            SegmentedButton<int>(
              segments: const [
                ButtonSegment(value: 15, label: Text('15 s')),
                ButtonSegment(value: 30, label: Text('30 s')),
                ButtonSegment(value: 60, label: Text('60 s')),
              ],
              selected: {seconds},
              onSelectionChanged: (s) => setLocal(() => seconds = s.first),
            ),
            const SizedBox(height: 12),
            TextField(controller: title, maxLength: 60, decoration: const InputDecoration(labelText: 'Title on the clip (optional)', hintText: 'Birdie on 7!')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save clip')),
        ],
      ),
    ),
  );
  final t = title.text.trim();
  title.dispose();
  return ok == true ? ClipRequest(cameraId, seconds, t.isEmpty ? null : t) : null;
}
