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

/// Quality for a measured upload speed: leave about a third spare for the mobile network's ups and downs.
String presetForKbps(int kbps) {
  if (kbps >= 7000) return '1080p30';
  if (kbps >= 3800) return '720p30';
  return '720p25-low';
}

/// One-tap camera setup (P1-10): the server names the camera ("Cam 2"), the rear camera is
/// used, and a quick upload test picks the quality. The volunteer sees one GO LIVE button;
/// name, quality, lens and (golf only) hole sit under "Settings".
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
  // The quality was chosen by hand in Settings: the upload test no longer changes it.
  bool _presetManual = false;
  int? _kbps;
  bool _testing = false;
  CameraFacing _facing = CameraFacing.back;
  bool _busy = false;
  bool _restored = false;
  String? _error;

  EventProfile get _profile => widget.tournament.profile;

  @override
  void initState() {
    super.initState();
    _restore();
    _speedTest();
  }

  Future<void> _restore() async {
    final p = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      // A name typed earlier on this phone is kept; otherwise the server picks "Cam N".
      _name.text = p.getString('cam.name') ?? '';
      _hole = p.getInt('cam.hole');
      _position = p.getString('cam.position') ?? 'Tee';
      final manual = p.getString('cam.presetManual');
      if (manual != null) {
        _preset = manual;
        _presetManual = true;
      }
      _restored = true;
    });
  }

  /// About 1 MB to our server (3 seconds on weak 4G), then the matching quality.
  Future<void> _speedTest() async {
    setState(() => _testing = true);
    final kbps = await _api.uploadSpeedKbps();
    if (!mounted) return;
    setState(() {
      _testing = false;
      _kbps = kbps;
      if (kbps != null && !_presetManual) _preset = presetForKbps(kbps);
    });
  }

  @override
  void dispose() {
    _name.dispose();
    _api.close();
    super.dispose();
  }

  Future<void> _goLive() async {
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
      final askPosition = _profile.positionLabel != null;
      final (camera, target) = await _api.registerCamera(
        tournamentId: widget.tournament.id,
        name: _name.text.trim().isEmpty ? null : _name.text.trim(),
        hole: askPosition ? _hole : null,
        position: askPosition ? _position : null,
        deviceId: deviceId,
        platform: defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
        deviceModel: device.model,
      );
      final p = await SharedPreferences.getInstance();
      if (_name.text.trim().isNotEmpty) await p.setString('cam.name', _name.text.trim());
      if (_hole != null) {
        await p.setInt('cam.hole', _hole!);
      } else {
        await p.remove('cam.hole');
      }
      await p.setString('cam.position', _position);
      if (_presetManual) {
        await p.setString('cam.presetManual', _preset);
      } else {
        await p.remove('cam.presetManual');
      }
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

  String get _qualityLine {
    final q = qualityPresets.firstWhere((x) => x.id == _preset);
    if (_testing) return 'Checking your upload speed…';
    if (_presetManual) return 'Quality: ${q.label} (chosen in Settings)';
    if (_kbps == null) return 'Quality: ${q.label}. Upload test did not run; check your signal.';
    return 'Upload ${(_kbps! / 1000).toStringAsFixed(1)} Mbps · quality ${q.label}';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (!_restored) {
      return Scaffold(appBar: AppBar(title: const Text('Camera')), body: const Center(child: CircularProgressIndicator()));
    }
    final weak = _kbps != null && _kbps! < 1800;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.tournament.name, overflow: TextOverflow.ellipsis),
        actions: [if (widget.session.isGuest) SignOutButton(session: widget.session)],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: ListView(
              padding: const EdgeInsets.all(20),
              children: [
                Text('Ready to film', style: theme.textTheme.headlineSmall),
                const SizedBox(height: 4),
                Text('Hold the phone sideways. The director picks which camera goes on air.', style: theme.textTheme.bodyMedium),
                const SizedBox(height: 24),
                SizedBox(
                  height: 96,
                  child: FilledButton.icon(
                    style: FilledButton.styleFrom(backgroundColor: Broadcast.onAir, foregroundColor: Colors.white, textStyle: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 2)),
                    onPressed: _busy ? null : _goLive,
                    icon: _busy ? const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white)) : const Icon(Icons.videocam, size: 34),
                    label: const Text('GO LIVE'),
                  ),
                ),
                const SizedBox(height: 12),
                Row(children: [
                  Icon(weak ? Icons.signal_cellular_connected_no_internet_4_bar : Icons.network_check, size: 18, color: weak ? Broadcast.warning : null),
                  const SizedBox(width: 8),
                  Expanded(child: Text(_qualityLine, style: theme.textTheme.bodySmall)),
                  if (!_testing) TextButton(onPressed: _speedTest, child: const Text('Test again')),
                ]),
                if (weak) Text('The signal is weak. Move to a better spot or use Wi-Fi if you can.', style: theme.textTheme.bodySmall?.copyWith(color: Broadcast.warning)),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
                ],
                const SizedBox(height: 12),
                Theme(
                  data: theme.copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    leading: const Icon(Icons.tune),
                    title: const Text('Settings'),
                    subtitle: Text(_name.text.trim().isEmpty ? 'Name, quality, lens' : _name.text.trim(), style: theme.textTheme.bodySmall),
                    children: [
                      TextField(
                        controller: _name,
                        textCapitalization: TextCapitalization.words,
                        decoration: const InputDecoration(labelText: 'Camera name (optional)', hintText: 'Left empty: Cam 1, Cam 2…'),
                        onChanged: (_) => setState(() {}),
                      ),
                      if (_profile.positionLabel != null) ...[
                        const SizedBox(height: 16),
                        Row(children: [
                          Expanded(
                            child: DropdownButtonFormField<int?>(
                              initialValue: _hole,
                              decoration: InputDecoration(labelText: '${_profile.positionLabel} (optional)'),
                              items: [
                                const DropdownMenuItem<int?>(value: null, child: Text('None')),
                                for (var h = 1; h <= 18; h++) DropdownMenuItem<int?>(value: h, child: Text('${_profile.positionLabel} $h')),
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
                        ]),
                      ],
                      const SizedBox(height: 16),
                      Align(alignment: Alignment.centerLeft, child: Text('Quality', style: theme.textTheme.titleSmall)),
                      RadioGroup<String>(
                        groupValue: _preset,
                        onChanged: (v) => setState(() {
                          _preset = v ?? '720p30';
                          _presetManual = true;
                        }),
                        child: Column(children: [
                          for (final q in qualityPresets) RadioListTile<String>(value: q.id, contentPadding: EdgeInsets.zero, title: Text(q.label), subtitle: Text(q.hint)),
                        ]),
                      ),
                      if (_presetManual)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            onPressed: () => setState(() {
                              _presetManual = false;
                              if (_kbps != null) _preset = presetForKbps(_kbps!);
                            }),
                            child: const Text('Pick quality from the upload test'),
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
                      const SizedBox(height: 12),
                    ],
                  ),
                ),
                const SizedBox(height: 8),
                PlatformNotice(),
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
