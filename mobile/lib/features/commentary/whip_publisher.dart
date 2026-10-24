import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import '../../core/realtime.dart' show Backoff;

enum MicState { idle, connecting, live, reconnecting, error }

/// Sends this phone's microphone to the media server over WebRTC (WHIP). Opus, echo
/// cancellation and noise suppression from the phone's own WebRTC stack; ~0.3 s latency.
/// The broadcast engine (OBS) mixes it under the programme with ducking.
class WhipPublisher extends ChangeNotifier {
  WhipPublisher({required this.whipUrl, required this.bearer});

  final String whipUrl;

  /// "com:<publish key>": MediaMTX hands user/pass to the server's auth hook.
  final String bearer;

  MicState state = MicState.idle;
  String? error;
  bool muted = false;

  /// Microphone level 0..1 (for the on-screen meter).
  double level = 0;

  MediaStream? _stream;
  RTCPeerConnection? _pc;
  Uri? _session;
  Timer? _stats;
  Timer? _retry;
  final _backoff = Backoff(base: const Duration(seconds: 1), max: const Duration(seconds: 8));
  bool _wanted = false;
  bool _disposed = false;
  int _gen = 0;

  bool get active => _wanted;

  Future<void> start() async {
    _wanted = true;
    await _connect();
  }

  Future<void> _connect() async {
    final gen = ++_gen;
    _retry?.cancel();
    await _teardown(keepMic: true);
    _set(_backoff.attempt == 0 ? MicState.connecting : MicState.reconnecting);
    try {
      _stream ??= await navigator.mediaDevices.getUserMedia({
        'audio': {'echoCancellation': true, 'noiseSuppression': true, 'autoGainControl': true},
        'video': false,
      });
      final track = _stream!.getAudioTracks().first;
      track.enabled = !muted;
      final pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'iceServers': [
          {'urls': 'stun:stun.l.google.com:19302'},
        ],
      });
      if (gen != _gen) {
        await pc.close();
        return;
      }
      _pc = pc;
      await pc.addTransceiver(
        track: track,
        kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendOnly, streams: [_stream!]),
      );
      pc.onConnectionState = (s) {
        if (gen != _gen) return;
        if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
          _backoff.reset();
          error = null;
          _set(MicState.live);
        } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
          _fail('Connection lost');
        }
      };
      final gathered = Completer<void>();
      pc.onIceGatheringState = (s) {
        if (s == RTCIceGatheringState.RTCIceGatheringStateComplete && !gathered.isCompleted) gathered.complete();
      };
      await pc.setLocalDescription(await pc.createOffer({}));
      await gathered.future.timeout(const Duration(seconds: 2), onTimeout: () {});
      final offer = await pc.getLocalDescription();
      if (offer?.sdp == null) throw Exception('No local SDP');
      final res = await http
          .post(Uri.parse(whipUrl), headers: {'Content-Type': 'application/sdp', 'Authorization': 'Bearer $bearer'}, body: offer!.sdp)
          .timeout(const Duration(seconds: 10));
      if (gen != _gen) return;
      if (res.statusCode == 401 || res.statusCode == 403) throw Exception('Microphone link not authorised. Join again.');
      if (res.statusCode == 400 && res.body.contains('another')) throw Exception('This commentary slot is already in use on another device.');
      if (res.statusCode != 201) throw Exception('Media server refused (${res.statusCode})');
      final location = res.headers['location'];
      if (location != null && location.isNotEmpty) _session = Uri.parse('$whipUrl/${location.split('/').last}');
      await pc.setRemoteDescription(RTCSessionDescription(res.body, 'answer'));
      _stats = Timer.periodic(const Duration(milliseconds: 250), (_) => _pollLevel(pc, gen));
    } on Object catch (e) {
      if (gen == _gen) _fail(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  Future<void> _pollLevel(RTCPeerConnection pc, int gen) async {
    try {
      final reports = await pc.getStats();
      for (final r in reports) {
        if (r.type == 'media-source' && r.values['kind'] == 'audio') {
          final l = r.values['audioLevel'];
          if (l is num && gen == _gen) {
            level = muted ? 0 : l.toDouble().clamp(0.0, 1.0);
            if (!_disposed) notifyListeners();
          }
        }
      }
    } on Object {
      // stats are best effort
    }
  }

  void _fail(String message) {
    error = message;
    _set(MicState.error);
    if (!_wanted || _disposed) return;
    final gen = _gen;
    _retry = Timer(_backoff.next(), () {
      if (_wanted && gen == _gen) _connect();
    });
  }

  void setMuted(bool m) {
    muted = m;
    for (final t in _stream?.getAudioTracks() ?? const <MediaStreamTrack>[]) {
      t.enabled = !m;
    }
    if (m) level = 0;
    if (!_disposed) notifyListeners();
  }

  Future<void> stop() async {
    _wanted = false;
    _gen++;
    _retry?.cancel();
    await _teardown(keepMic: false);
    _backoff.reset();
    level = 0;
    _set(MicState.idle);
  }

  Future<void> _teardown({required bool keepMic}) async {
    _stats?.cancel();
    final pc = _pc;
    final session = _session;
    _pc = null;
    _session = null;
    if (session != null) {
      unawaited(http.delete(session, headers: {'Authorization': 'Bearer $bearer'}).then((_) {}, onError: (Object _) {}));
    }
    await pc?.close();
    if (!keepMic) {
      for (final t in _stream?.getTracks() ?? const <MediaStreamTrack>[]) {
        await t.stop();
      }
      await _stream?.dispose();
      _stream = null;
    }
  }

  void _set(MicState s) {
    state = s;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(stop());
    super.dispose();
  }
}
