import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import 'camera_session.dart';

/// Full-screen, landscape camera with live status. Red frame = this camera is on air.
class CameraScreen extends StatefulWidget {
  const CameraScreen({super.key, required this.session, required this.camera, required this.target, required this.config});

  final Session session;
  final CameraInfo camera;
  final PublishTarget target;
  final StreamConfig config;

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> {
  late final CameraSession _cam = CameraSession(
    session: widget.session,
    camera: widget.camera,
    target: widget.target,
    config: widget.config,
  );

  @override
  void initState() {
    super.initState();
    // Broadcast is 16:9 landscape; lock so the encoder orientation never flips mid-stream.
    SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
    _cam.open();
  }

  @override
  void dispose() {
    _cam.close().whenComplete(_cam.dispose);
    SystemChrome.setPreferredOrientations(const []);
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  Future<bool> _confirmLeave() async {
    if (!_cam.wantLive) return true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Stop streaming?'),
        content: const Text('This camera will disappear from the control room.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep streaming')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Stop and leave')),
        ],
      ),
    );
    return ok == true;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _confirmLeave() && context.mounted) Navigator.of(context).pop();
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: ListenableBuilder(
          listenable: _cam,
          builder: (context, _) => _buildBody(context),
        ),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    final cam = _cam;
    final frameColor = cam.onAir ? Broadcast.onAir : (cam.inPreview ? Broadcast.preview : Colors.transparent);
    return Stack(
      fit: StackFit.expand,
      children: [
        if (cam.phase != CameraPhase.error) const CgCameraPreview(),
        // Tally frame
        IgnorePointer(
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            decoration: BoxDecoration(border: Border.all(color: frameColor, width: cam.onAir ? 8 : 5)),
          ),
        ),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              children: [
                _topBar(cam),
                const Spacer(),
                if (cam.message != null || cam.phase == CameraPhase.paused) _messageBanner(cam),
                const SizedBox(height: 10),
                _bottomBar(cam),
              ],
            ),
          ),
        ),
        if (cam.phase == CameraPhase.starting) const Center(child: CircularProgressIndicator()),
      ],
    );
  }

  Widget _topBar(CameraSession cam) {
    final (label, color, icon) = switch (cam.phase) {
      CameraPhase.starting => ('OPENING CAMERA', Broadcast.offline, Icons.hourglass_empty),
      CameraPhase.ready => ('NOT LIVE', Broadcast.offline, Icons.videocam_off),
      CameraPhase.connecting => ('CONNECTING', Broadcast.warning, Icons.sync),
      CameraPhase.live => ('LIVE TO CONTROL ROOM', Broadcast.preview, Icons.wifi_tethering),
      CameraPhase.reconnecting => ('RECONNECTING (${cam.reconnectAttempts})', Broadcast.warning, Icons.sync_problem),
      CameraPhase.paused => ('PAUSED BY SYSTEM', Broadcast.warning, Icons.pause_circle),
      CameraPhase.error => ('CAMERA ERROR', Broadcast.onAir, Icons.error),
    };
    final linkOk = cam.link?.state.value == LinkState.connected;
    final battery = cam.device?.battery;
    return Row(
      children: [
        StatusPill(label: label, color: color, icon: icon),
        const SizedBox(width: 8),
        if (cam.onAir) const StatusPill(label: 'ON AIR', color: Broadcast.onAir, icon: Icons.circle),
        if (!cam.onAir && cam.inPreview) const StatusPill(label: 'PREVIEW', color: Broadcast.preview),
        const Spacer(),
        _chip(Icons.place, '${cam.camera.name} · ${cam.camera.assignment}'),
        const SizedBox(width: 8),
        if (cam.phase == CameraPhase.live) ...[
          _chip(Icons.timer, formatDuration(cam.liveFor)),
          const SizedBox(width: 8),
          _chip(Icons.upload, formatKbps(cam.uploadKbps)),
          const SizedBox(width: 8),
        ],
        if (battery != null)
          _chip(
            cam.device?.charging == true ? Icons.battery_charging_full : Icons.battery_std,
            '$battery%',
            warn: battery < 20 && cam.device?.charging != true,
          ),
        const SizedBox(width: 8),
        Tooltip(
          message: linkOk ? 'Connected to control room' : 'Control room link reconnecting',
          child: Icon(linkOk ? Icons.cloud_done : Icons.cloud_off, color: linkOk ? Colors.white70 : Broadcast.warning),
        ),
      ],
    );
  }

  Widget _chip(IconData icon, String text, {bool warn = false}) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(6)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 14, color: warn ? Broadcast.warning : Colors.white70),
          const SizedBox(width: 4),
          Text(text, style: TextStyle(color: warn ? Broadcast.warning : Colors.white, fontSize: 12.5)),
        ]),
      );

  Widget _messageBanner(CameraSession cam) {
    var text = cam.message ?? '';
    if (cam.phase == CameraPhase.reconnecting && cam.retryAt != null) {
      final secs = cam.retryAt!.difference(DateTime.now()).inSeconds;
      text = '$text  Retrying${secs > 0 ? ' in ${secs}s' : '…'}';
    }
    if (cam.phase == CameraPhase.paused && defaultTargetPlatform == TargetPlatform.iOS) {
      text = '${text.isEmpty ? '' : '$text '}Keep the app open and the screen unlocked.';
    }
    return Container(
      constraints: const BoxConstraints(maxWidth: 640),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.75), borderRadius: BorderRadius.circular(10)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.warning_amber, color: Broadcast.warning, size: 20),
        const SizedBox(width: 8),
        Flexible(child: Text(text, style: const TextStyle(color: Colors.white))),
      ]),
    );
  }

  Widget _bottomBar(CameraSession cam) {
    final live = cam.wantLive;
    return Row(
      children: [
        IconButton.filledTonal(
          tooltip: 'Back',
          onPressed: () async {
            if (await _confirmLeave() && mounted) Navigator.of(this.context).pop();
          },
          icon: const Icon(Icons.arrow_back),
        ),
        const SizedBox(width: 8),
        IconButton.filledTonal(
          tooltip: 'Switch camera',
          onPressed: cam.phase == CameraPhase.error ? null : cam.switchCamera,
          icon: const Icon(Icons.cameraswitch),
        ),
        const Spacer(),
        SizedBox(
          height: 56,
          child: FilledButton.icon(
            style: FilledButton.styleFrom(
              backgroundColor: live ? Colors.white : Broadcast.onAir,
              foregroundColor: live ? Colors.black : Colors.white,
              padding: const EdgeInsets.symmetric(horizontal: 28),
            ),
            onPressed: switch (cam.phase) {
              CameraPhase.starting || CameraPhase.error => null,
              _ => live ? cam.stopLive : cam.goLive,
            },
            icon: Icon(live ? Icons.stop : Icons.fiber_manual_record),
            label: Text(live ? 'STOP' : 'GO LIVE', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          ),
        ),
      ],
    );
  }
}
