import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../ui/widgets.dart';

/// Polls a camera's multiview thumbnail (a small JPEG made server-side every ~2 s).
/// 9+ tiles cost a few KB/s each instead of one video decode per tile.
class ThumbnailImage extends StatefulWidget {
  const ThumbnailImage({super.key, required this.api, required this.path, required this.active, this.interval = const Duration(seconds: 2)});

  final ApiClient api;
  final String path;
  final bool active;
  final Duration interval;

  @override
  State<ThumbnailImage> createState() => _ThumbnailImageState();
}

class _ThumbnailImageState extends State<ThumbnailImage> {
  Uint8List? _bytes;
  String? _etag;
  Timer? _timer;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _schedule();
  }

  @override
  void didUpdateWidget(covariant ThumbnailImage old) {
    super.didUpdateWidget(old);
    if (old.path != widget.path) {
      _bytes = null;
      _etag = null;
    }
    if (old.active != widget.active || old.path != widget.path) _schedule();
  }

  void _schedule() {
    _timer?.cancel();
    if (!widget.active) return;
    _load();
    _timer = Timer.periodic(widget.interval, (_) => _load());
  }

  Future<void> _load() async {
    if (_loading) return;
    _loading = true;
    try {
      final (bytes, etag) = await widget.api.thumbnail(widget.path, etag: _etag);
      if (bytes != null && mounted) {
        setState(() {
          _bytes = bytes;
          _etag = etag;
        });
      }
    } on Object {
      // keep showing the last frame
    } finally {
      _loading = false;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final b = _bytes;
    if (b == null) {
      return const ColoredBox(
        color: Color(0xFF0B0E10),
        child: Center(child: Icon(Icons.videocam_off, color: Colors.white24, size: 28)),
      );
    }
    return Image.memory(b, fit: BoxFit.cover, gaplessPlayback: true, filterQuality: FilterQuality.low);
  }
}

/// One multiview tile: picture, name, hole/position, status, ON AIR / PREVIEW borders.
/// Tap = preview. CUT button (or double-tap) = put on air immediately.
class CameraTile extends StatelessWidget {
  const CameraTile({
    super.key,
    required this.api,
    required this.camera,
    required this.onAir,
    required this.inPreview,
    required this.canSwitch,
    required this.onPreview,
    required this.onCut,
    required this.onEdit,
  });

  final ApiClient api;
  final CameraInfo camera;
  final bool onAir;
  final bool inPreview;
  final bool canSwitch;
  final VoidCallback onPreview;
  final VoidCallback onCut;
  final VoidCallback onEdit;

  @override
  Widget build(BuildContext context) {
    final live = camera.status == FeedStatus.live;
    final border = onAir ? Broadcast.onAir : (inPreview ? Broadcast.preview : Colors.white12);
    final t = camera.telemetry;
    final (statusLabel, statusColor) = switch (camera.status) {
      FeedStatus.live => ('LIVE', Broadcast.preview),
      FeedStatus.connecting => ('CONNECTING', Broadcast.warning),
      FeedStatus.paused => ('PAUSED', Broadcast.warning),
      FeedStatus.offline => ('NO SIGNAL', Broadcast.offline),
    };
    return GestureDetector(
      onTap: canSwitch && live ? onPreview : null,
      onDoubleTap: canSwitch && live ? onCut : null,
      onLongPress: onEdit,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        decoration: BoxDecoration(
          color: Broadcast.panel,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: border, width: onAir || inPreview ? 3 : 1),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ThumbnailImage(api: api, path: camera.thumbnailUrl, active: live),
                  if (!live) Container(color: Colors.black54),
                  Positioned(
                    left: 6,
                    top: 6,
                    child: Row(children: [
                      if (onAir) const StatusPill(label: 'ON AIR', color: Broadcast.onAir, dense: true),
                      if (!onAir && inPreview) const StatusPill(label: 'PVW', color: Broadcast.preview, dense: true),
                      if (!onAir && !inPreview) StatusPill(label: statusLabel, color: statusColor, dense: true),
                    ]),
                  ),
                  if (t?.battery != null)
                    Positioned(
                      right: 6,
                      top: 6,
                      child: _miniBadge(
                        t!.charging == true ? Icons.battery_charging_full : Icons.battery_std,
                        '${t.battery}%',
                        warn: (t.battery ?? 100) < 20 && t.charging != true,
                      ),
                    ),
                  if (live)
                    Positioned(
                      right: 6,
                      bottom: 6,
                      child: _miniBadge(Icons.signal_cellular_alt, formatKbps(camera.health.inboundKbps),
                          warn: camera.health.inboundKbps < 400),
                    ),
                  if (camera.status == FeedStatus.paused)
                    const Center(child: Text('Paused by phone OS', style: TextStyle(color: Colors.white70, fontSize: 12))),
                ],
              ),
            ),
            Container(
              color: Broadcast.panelHigh,
              padding: const EdgeInsets.fromLTRB(8, 4, 4, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(camera.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 13)),
                        Text(
                          '${camera.assignment}${camera.platform != null ? ' · ${camera.platform}' : ''}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.white60, fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                  SizedBox(
                    height: 30,
                    child: FilledButton(
                      style: FilledButton.styleFrom(
                        backgroundColor: Broadcast.onAir,
                        padding: const EdgeInsets.symmetric(horizontal: 10),
                        visualDensity: VisualDensity.compact,
                      ),
                      onPressed: canSwitch && live && !onAir ? onCut : null,
                      child: const Text('CUT', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12)),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _miniBadge(IconData icon, String text, {bool warn = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(4)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 11, color: warn ? Broadcast.warning : Colors.white70),
          const SizedBox(width: 3),
          Text(text, style: TextStyle(color: warn ? Broadcast.warning : Colors.white, fontSize: 10.5)),
        ]),
      );
}
