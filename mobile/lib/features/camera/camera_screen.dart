import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';
import '../../core/realtime.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import 'camera_controls.dart';
import 'camera_session.dart';

/// Full-screen camera with live status. Red frame = this camera is on air.
/// Brightness arc on the left, zoom arc on the right; tap the picture to focus there,
/// long-press to lock focus and brightness; the padlock freezes every control.
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
    // Landscape (16:9) either way round: the camera keeps the picture upright when the phone
    // turns over. Portrait (9:16) is chosen with the Portrait button, not by tilting the phone.
    _allowOrientations(widget.config.portrait);
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

  void _allowOrientations(bool portrait) => SystemChrome.setPreferredOrientations(portrait
      ? [DeviceOrientation.portraitUp, DeviceOrientation.portraitDown]
      : [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);

  Future<void> _togglePortrait() async {
    final cam = _cam;
    final toPortrait = !cam.portrait;
    if (cam.onAir) {
      _hint('This camera is ON AIR. Change portrait / landscape when the director is on another camera.');
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(toPortrait ? 'Switch to portrait (9:16)?' : 'Switch to landscape (16:9)?'),
        content: Text(toPortrait
            ? 'Hold the phone upright. The camera reconnects in a few seconds. In the normal 16:9 show this camera has black bars at the sides; it fills vertical outputs such as Instagram.'
            : 'Hold the phone sideways. The camera reconnects in a few seconds.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(toPortrait ? 'Portrait' : 'Landscape')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    _allowOrientations(toPortrait);
    if (!await cam.setPortrait(toPortrait)) _allowOrientations(cam.portrait);
  }

  void _hint(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 3)));
  }

  // Where the operator tapped (for the focus square), in screen pixels.
  Offset? _marker;
  int _markerId = 0;

  /// A tap on the screen -> a point of the picture (0..1). The picture is fitted inside the
  /// screen (16:9 or 9:16), so taps on the black bars count as its nearest edge.
  Offset _toPicture(Offset p, Size screen) {
    final aspect = _cam.portrait ? 9 / 16 : 16 / 9;
    var w = screen.width, h = screen.width / aspect;
    if (h > screen.height) {
      h = screen.height;
      w = h * aspect;
    }
    final left = (screen.width - w) / 2, top = (screen.height - h) / 2;
    return Offset(((p.dx - left) / w).clamp(0.0, 1.0), ((p.dy - top) / h).clamp(0.0, 1.0));
  }

  void _showMarker(Offset at) {
    final id = ++_markerId;
    setState(() => _marker = at);
    Future<void>.delayed(const Duration(milliseconds: 1400), () {
      if (mounted && id == _markerId && !_cam.aeAfLocked) setState(() => _marker = null);
    });
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
    final locked = cam.controlsLocked;
    final ready = cam.phase != CameraPhase.error && cam.phase != CameraPhase.starting;
    return LayoutBuilder(builder: (context, box) {
      final screen = Size(box.maxWidth, box.maxHeight);
      final arcH = (box.maxHeight * (cam.portrait ? 0.36 : 0.5)).clamp(150.0, 320.0);
      final caps = cam.caps;
      final zoomOk = ready && caps.zoomMax > caps.zoomMin + 0.01;
      final evOk = ready && caps.evMax > caps.evMin;
      return Stack(
        fit: StackFit.expand,
        children: [
          if (cam.phase != CameraPhase.error) const CgCameraPreview(),
          // Tap = focus and brightness there; long-press = lock them.
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.translucent,
              onTapUp: !ready
                  ? null
                  : (d) {
                      if (locked) return _hint('Controls are locked. Hold the padlock to unlock.');
                      if (!caps.focusPoint) return;
                      final p = _toPicture(d.localPosition, screen);
                      _showMarker(d.localPosition);
                      cam.focusAt(p.dx, p.dy);
                    },
              onLongPressStart: !ready
                  ? null
                  : (d) {
                      if (locked) return;
                      final p = _toPicture(d.localPosition, screen);
                      _showMarker(d.localPosition);
                      cam.lockAt(p.dx, p.dy);
                    },
            ),
          ),
          if (_marker != null)
            Positioned(
              left: _marker!.dx - 36,
              top: _marker!.dy - 36,
              child: IgnorePointer(child: FocusMarker(key: ValueKey(_markerId), locked: cam.aeAfLocked)),
            ),
          // Tally frame
          IgnorePointer(
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              decoration: BoxDecoration(border: Border.all(color: frameColor, width: cam.onAir ? 8 : 5)),
            ),
          ),
          // Brightness (left) and zoom (right) arcs.
          SafeArea(
            child: Stack(children: [
              Align(
                alignment: Alignment.centerLeft,
                child: AbsorbPointer(
                  absorbing: locked,
                  child: Opacity(
                    opacity: locked ? 0.45 : 1,
                    child: EdgeArc(
                      side: ArcSide.left,
                      title: 'Brightness',
                      icon: Icons.wb_sunny_outlined,
                      height: arcH,
                      enabled: evOk,
                      fillFrom: evOk ? ((0 - caps.evMin) / (caps.evMax - caps.evMin)).clamp(0.0, 1.0) : 0,
                      value: evOk ? ((cam.ev - caps.evMin) / (caps.evMax - caps.evMin)).clamp(0.0, 1.0) : 0.5,
                      label: evLabel(cam.ev),
                      ticks: evOk
                          ? [
                              for (var e = caps.evMin.ceil(); e <= caps.evMax.floor(); e++)
                                ((e - caps.evMin) / (caps.evMax - caps.evMin), e == 0 ? '0' : (e.isEven ? (e > 0 ? '+$e' : '−${-e}') : '')),
                            ]
                          : const [],
                      onChanged: (v) => cam.setBrightness(caps.evMin + v * (caps.evMax - caps.evMin)),
                      onReset: () => cam.setBrightness(0),
                    ),
                  ),
                ),
              ),
              Align(
                alignment: Alignment.centerRight,
                child: AbsorbPointer(
                  absorbing: locked,
                  child: Opacity(
                    opacity: locked ? 0.45 : 1,
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      ZoomPresets(zoom: cam.zoom, min: caps.zoomMin, max: caps.zoomMax, enabled: zoomOk, onPick: cam.setZoom),
                      EdgeArc(
                        side: ArcSide.right,
                        title: 'Zoom',
                        icon: Icons.zoom_in,
                        height: arcH,
                        enabled: zoomOk,
                        value: zoomToArc(cam.zoom, caps.zoomMin, caps.zoomMax),
                        label: zoomLabel(cam.zoom),
                        ticks: [
                          for (final p in const [0.5, 1.0, 2.0, 5.0, 10.0])
                            if (p >= caps.zoomMin - 0.01 && p <= caps.zoomMax + 0.01)
                              (zoomToArc(p, caps.zoomMin, caps.zoomMax), p == 0.5 ? '.5' : '${p.round()}'),
                        ],
                        onChanged: (v) => cam.setZoom(arcToZoom(v, caps.zoomMin, caps.zoomMax)),
                        onReset: () => cam.setZoom(1),
                      ),
                    ]),
                  ),
                ),
              ),
            ]),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                children: [
                  _topBar(cam),
                  const SizedBox(height: 8),
                  Wrap(spacing: 8, runSpacing: 6, alignment: WrapAlignment.center, children: [
                    if (cam.aeAfLocked)
                      _pill('AE/AF LOCK · tap the picture to release', Broadcast.warning, onTap: locked
                              ? null
                              : () {
                                  cam.unlockAeAf();
                                  setState(() => _marker = null);
                                }),
                    if (locked) _pill('CONTROLS LOCKED · hold the padlock to unlock', Colors.white),
                    if (cam.lensSwitching) _pill('Switching lens…', Colors.white),
                  ]),
                  const Spacer(),
                  if (cam.message != null || cam.phase == CameraPhase.paused) _messageBanner(cam),
                  if (!cam.autoFocus && caps.manualFocus) ...[
                    const SizedBox(height: 8),
                    AbsorbPointer(absorbing: locked, child: _focusSlider(cam)),
                  ],
                  const SizedBox(height: 10),
                  _bottomBar(cam),
                ],
              ),
            ),
          ),
          if (cam.phase == CameraPhase.starting) const Center(child: CircularProgressIndicator()),
        ],
      );
    });
  }

  Widget _pill(String text, Color color, {VoidCallback? onTap}) => GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.7), borderRadius: BorderRadius.circular(6), border: Border.all(color: color)),
          child: Text(text, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w800)),
        ),
      );

  Widget _focusSlider(CameraSession cam) => Container(
        constraints: const BoxConstraints(maxWidth: 360),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(color: Colors.black54, borderRadius: BorderRadius.circular(24)),
        child: Row(children: [
          const Icon(Icons.landscape, size: 18, color: Colors.white70),
          Expanded(
            child: Slider(
              value: cam.focusNear,
              onChanged: cam.setFocusNear,
              activeColor: Broadcast.warning,
              semanticFormatterCallback: (v) => v < 0.05 ? 'Far' : (v > 0.95 ? 'Closest' : '${(v * 100).round()}% near'),
            ),
          ),
          const Icon(Icons.local_florist, size: 18, color: Colors.white70),
        ]),
      );

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
        const SizedBox(width: 8),
        Expanded(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            reverse: true,
            child: Row(children: [
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
            ]),
          ),
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
    final locked = cam.controlsLocked;
    final ready = cam.phase != CameraPhase.error && cam.phase != CameraPhase.starting;
    final caps = cam.caps;
    final tools = <Widget>[
      ToolButton(
        icon: cam.autoFocus ? Icons.center_focus_strong : Icons.center_focus_weak,
        label: cam.autoFocus ? 'AF' : 'MF',
        on: !cam.autoFocus,
        onTap: ready && caps.manualFocus ? () => cam.setAutoFocus(!cam.autoFocus) : null,
      ),
      if (caps.torch)
        ToolButton(
          icon: cam.torch ? Icons.flashlight_on : Icons.flashlight_off,
          label: 'Light',
          on: cam.torch,
          onTap: ready ? cam.toggleTorch : null,
        ),
      ToolButton(
        icon: cam.portrait ? Icons.stay_current_landscape : Icons.stay_current_portrait,
        label: cam.portrait ? 'Landscape' : 'Portrait',
        onTap: ready ? _togglePortrait : null,
      ),
      MicMeter(level: cam.audioLevel),
    ];
    final padlock = Semantics(
      button: true,
      label: locked ? 'Unlock controls (hold)' : 'Lock controls',
      child: GestureDetector(
        onTap: () => locked ? _hint('Hold the padlock to unlock the controls.') : cam.setControlsLocked(true),
        onLongPress: locked ? () => cam.setControlsLocked(false) : null,
        child: Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: locked ? Broadcast.warning : Colors.black54,
            border: Border.all(color: Colors.white24),
          ),
          child: Icon(locked ? Icons.lock : Icons.lock_open, color: locked ? Colors.black : Colors.white),
        ),
      ),
    );
    final back = IconButton.filledTonal(
      tooltip: 'Back',
      onPressed: () async {
        if (await _confirmLeave() && mounted) Navigator.of(this.context).pop();
      },
      icon: const Icon(Icons.arrow_back),
    );
    final switchCam = IconButton.filledTonal(
      tooltip: 'Switch camera',
      onPressed: cam.phase == CameraPhase.error ? null : cam.switchCamera,
      icon: const Icon(Icons.cameraswitch),
    );
    final goLive = SizedBox(
      height: 56,
      child: FilledButton.icon(
        style: FilledButton.styleFrom(
          backgroundColor: live ? Colors.white : Broadcast.onAir,
          foregroundColor: live ? Colors.black : Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 24),
        ),
        onPressed: switch (cam.phase) {
          CameraPhase.starting || CameraPhase.error => null,
          _ => live ? cam.stopLive : cam.goLive,
        },
        icon: Icon(live ? Icons.stop : Icons.fiber_manual_record),
        label: Text(live ? 'STOP' : 'GO LIVE', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
      ),
    );
    Widget frozen(Widget w) => AbsorbPointer(absorbing: locked, child: Opacity(opacity: locked ? 0.45 : 1, child: w));
    if (cam.portrait) {
      return Column(mainAxisSize: MainAxisSize.min, children: [
        frozen(SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [for (final t in tools) Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: t)]),
        )),
        const SizedBox(height: 10),
        Row(children: [
          frozen(back),
          const SizedBox(width: 8),
          frozen(switchCam),
          const Spacer(),
          padlock,
          const SizedBox(width: 10),
          frozen(goLive),
        ]),
      ]);
    }
    return Row(
      children: [
        frozen(back),
        const SizedBox(width: 8),
        frozen(switchCam),
        const SizedBox(width: 12),
        Expanded(
          child: frozen(SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(children: [for (final t in tools) Padding(padding: const EdgeInsets.only(right: 8), child: t)]),
          )),
        ),
        padlock,
        const SizedBox(width: 10),
        frozen(goLive),
      ],
    );
  }
}
