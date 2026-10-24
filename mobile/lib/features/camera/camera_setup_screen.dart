import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import 'camera_screen.dart';

class QualityPreset {
  const QualityPreset(this.id, this.label, this.hint, this.config);
  final String id;
  final String label;
  final String hint;
  final StreamConfig config;
}

const qualityPresets = <QualityPreset>[
  QualityPreset('720p30', '720p · 30 fps', 'Recommended on 4G. ~2.5 Mbps upload.',
      StreamConfig(width: 1280, height: 720, fps: 30, videoBitrateKbps: 2500)),
  QualityPreset('720p25-low', '720p · 25 fps (weak signal)', 'For poor coverage. ~1.5 Mbps.',
      StreamConfig(width: 1280, height: 720, fps: 25, videoBitrateKbps: 1500)),
  QualityPreset('1080p30', '1080p · 30 fps', 'Strong 4G/5G or Wi-Fi only. ~4.5 Mbps.',
      StreamConfig(width: 1920, height: 1080, fps: 30, videoBitrateKbps: 4500)),
  QualityPreset('720p60', '720p · 60 fps (fast action)', 'Smooth swings. ~4 Mbps.',
      StreamConfig(width: 1280, height: 720, fps: 60, videoBitrateKbps: 4000)),
];

const positions = ['Tee', 'Fairway', 'Green', 'Clubhouse', 'Roaming', 'Other'];

/// Register this phone as a camera: tournament, name, hole and position, quality.
class CameraSetupScreen extends StatefulWidget {
  const CameraSetupScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<CameraSetupScreen> createState() => _CameraSetupScreenState();
}

class _CameraSetupScreenState extends State<CameraSetupScreen> {
  late final ApiClient _api = widget.session.api();
  final _name = TextEditingController();
  int? _hole;
  String _position = 'Tee';
  String _preset = '720p30';
  CameraFacing _facing = CameraFacing.back;
  bool _busy = false;
  bool _restored = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final p = await SharedPreferences.getInstance();
    setState(() {
      _name.text = p.getString('cam.name') ?? '';
      _hole = p.getInt('cam.hole');
      _position = p.getString('cam.position') ?? 'Tee';
      _preset = p.getString('cam.preset') ?? '720p30';
      _restored = true;
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _api.close();
    super.dispose();
  }

  Future<void> _continue() async {
    final name = _name.text.trim();
    if (name.isEmpty) return setState(() => _error = 'Give this camera a name, e.g. "Hole 7 Green".');
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final granted = await CgStreamer.requestPermissions();
      if (!granted) {
        setState(() => _error = 'Camera and microphone access are needed to stream. Allow them in Settings.');
        return;
      }
      final device = await CgStreamer.deviceStatus();
      final deviceId = await CgStreamer.deviceId();
      final (camera, target) = await _api.registerCamera(
        tournamentId: widget.tournament.id,
        name: name,
        hole: _hole,
        position: _position,
        deviceId: deviceId,
        platform: defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
        deviceModel: device.model,
      );
      final p = await SharedPreferences.getInstance();
      await p.setString('cam.name', name);
      if (_hole != null) {
        await p.setInt('cam.hole', _hole!);
      } else {
        await p.remove('cam.hole');
      }
      await p.setString('cam.position', _position);
      await p.setString('cam.preset', _preset);
      final preset = qualityPresets.firstWhere((q) => q.id == _preset);
      final cfg = StreamConfig(
        width: preset.config.width,
        height: preset.config.height,
        fps: preset.config.fps,
        videoBitrateKbps: preset.config.videoBitrateKbps,
        facing: _facing,
      );
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => CameraScreen(session: widget.session, camera: camera, target: target, config: cfg),
      ));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } on Exception catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_restored) {
      return Scaffold(appBar: AppBar(title: const Text('Camera setup')), body: const Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      appBar: AppBar(
        title: Text('Camera · ${widget.tournament.name}', overflow: TextOverflow.ellipsis),
        actions: [if (widget.session.isGuest) SignOutButton(session: widget.session)],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text(widget.tournament.title, style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                Text('Name this camera and say where it is. The director sees it in the control room.',
                    style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 16),
                TextField(
                  controller: _name,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(labelText: 'Camera name', hintText: 'Hole 7 Green'),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<int?>(
                        initialValue: _hole,
                        decoration: const InputDecoration(labelText: 'Hole'),
                        items: [
                          const DropdownMenuItem<int?>(value: null, child: Text('None')),
                          for (var h = 1; h <= 18; h++) DropdownMenuItem<int?>(value: h, child: Text('Hole $h')),
                        ],
                        onChanged: (v) => setState(() => _hole = v),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: DropdownButtonFormField<String>(
                        initialValue: positions.contains(_position) ? _position : 'Other',
                        decoration: const InputDecoration(labelText: 'Position'),
                        items: [for (final p in positions) DropdownMenuItem(value: p, child: Text(p))],
                        onChanged: (v) => setState(() => _position = v ?? 'Tee'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 20),
                Text('Quality', style: Theme.of(context).textTheme.titleSmall),
                RadioGroup<String>(
                  groupValue: _preset,
                  onChanged: (v) => setState(() => _preset = v ?? '720p30'),
                  child: Column(
                    children: [
                      for (final q in qualityPresets)
                        RadioListTile<String>(
                          value: q.id,
                          contentPadding: EdgeInsets.zero,
                          title: Text(q.label),
                          subtitle: Text(q.hint),
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                SegmentedButton<CameraFacing>(
                  segments: const [
                    ButtonSegment(value: CameraFacing.back, label: Text('Rear camera'), icon: Icon(Icons.camera_rear)),
                    ButtonSegment(value: CameraFacing.front, label: Text('Front camera'), icon: Icon(Icons.camera_front)),
                  ],
                  selected: {_facing},
                  onSelectionChanged: (s) => setState(() => _facing = s.first),
                ),
                const SizedBox(height: 20),
                PlatformNotice(),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
                ],
                const SizedBox(height: 20),
                FilledButton.icon(
                  onPressed: _busy ? null : _continue,
                  icon: _busy
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.videocam),
                  label: const Text('Open camera'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Honest, platform-specific explanation of what happens when the screen is off or the app is closed.
class PlatformNotice extends StatelessWidget {
  const PlatformNotice({super.key});

  @override
  Widget build(BuildContext context) {
    final ios = defaultTargetPlatform == TargetPlatform.iOS;
    return InfoBanner(
      icon: ios ? Icons.phone_iphone : Icons.phone_android,
      text: ios
          ? 'iPhone/iPad: keep this app open and the screen unlocked while live. iOS stops the camera '
              'when the app is in the background or the device is locked; the control room will show this '
              'feed as paused until you return. Use a power bank.'
          : 'Android: streaming continues with the screen off (a "camera is live" notification stays visible). '
              'Do not swipe the app away. Turn off battery optimisation for this app and use a power bank.',
    );
  }
}
