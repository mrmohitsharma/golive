import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

/// Low-latency WebRTC (WHEP) player for a MediaMTX path. Used for the Preview and
/// Programme monitors. Video only: phones send AAC audio, which WebRTC cannot carry,
/// so programme audio is monitored in OBS / on YouTube.
class WhepView extends StatefulWidget {
  const WhepView({super.key, required this.url, required this.token, this.placeholder});

  /// null = nothing to show (no camera selected).
  final String? url;
  final String token;
  final Widget? placeholder;

  @override
  State<WhepView> createState() => _WhepViewState();
}

class _WhepViewState extends State<WhepView> {
  final _renderer = RTCVideoRenderer();
  RTCPeerConnection? _pc;
  Uri? _session;
  bool _rendererReady = false;
  bool _connecting = false;
  bool _hasVideo = false;
  String? _error;
  int _generation = 0;
  Timer? _retry;

  @override
  void initState() {
    super.initState();
    _renderer.initialize().then((_) {
      if (!mounted) return;
      _rendererReady = true;
      _connect();
    });
  }

  @override
  void didUpdateWidget(covariant WhepView old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url || old.token != widget.token) _connect();
  }

  @override
  void dispose() {
    _generation++;
    _retry?.cancel();
    _teardown();
    _renderer.dispose();
    super.dispose();
  }

  Future<void> _teardown() async {
    final pc = _pc;
    final session = _session;
    _pc = null;
    _session = null;
    if (session != null) {
      unawaited(http.delete(session, headers: {'Authorization': 'Bearer ${widget.token}'}).catchError((Object _) => http.Response('', 0)));
    }
    if (_rendererReady) _renderer.srcObject = null;
    await pc?.close();
  }

  Future<void> _connect() async {
    final gen = ++_generation;
    _retry?.cancel();
    await _teardown();
    final url = widget.url;
    if (!mounted || gen != _generation) return;
    if (url == null || !_rendererReady) {
      setState(() {
        _connecting = false;
        _hasVideo = false;
        _error = null;
      });
      return;
    }
    setState(() {
      _connecting = true;
      _hasVideo = false;
      _error = null;
    });
    try {
      final pc = await createPeerConnection({
        'sdpSemantics': 'unified-plan',
        'iceServers': [
          {'urls': 'stun:stun.l.google.com:19302'},
        ],
      });
      if (gen != _generation) {
        await pc.close();
        return;
      }
      _pc = pc;
      await pc.addTransceiver(
        kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
        init: RTCRtpTransceiverInit(direction: TransceiverDirection.RecvOnly),
      );
      pc.onTrack = (RTCTrackEvent e) async {
        if (gen != _generation || e.track.kind != 'video') return;
        if (e.streams.isNotEmpty) {
          _renderer.srcObject = e.streams.first;
        } else {
          final stream = await createLocalMediaStream('whep');
          await stream.addTrack(e.track);
          _renderer.srcObject = stream;
        }
        if (mounted) setState(() => _hasVideo = true);
      };
      pc.onConnectionState = (RTCPeerConnectionState s) {
        if (gen != _generation) return;
        if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected && mounted) {
          setState(() => _connecting = false);
        }
        if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
            s == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
          _fail('Preview connection lost');
        }
      };

      final gathered = Completer<void>();
      pc.onIceGatheringState = (RTCIceGatheringState s) {
        if (s == RTCIceGatheringState.RTCIceGatheringStateComplete && !gathered.isCompleted) gathered.complete();
      };
      await pc.setLocalDescription(await pc.createOffer({}));
      await gathered.future.timeout(const Duration(seconds: 2), onTimeout: () {});
      final offer = await pc.getLocalDescription();
      if (offer?.sdp == null) throw Exception('No local SDP');

      final endpoint = Uri.parse(url);
      final res = await http
          .post(endpoint, headers: {'Content-Type': 'application/sdp', 'Authorization': 'Bearer ${widget.token}'}, body: offer!.sdp)
          .timeout(const Duration(seconds: 10));
      if (gen != _generation) return;
      if (res.statusCode == 404) throw Exception('No signal from this camera');
      if (res.statusCode == 401 || (res.statusCode == 400 && res.body.contains('authentication'))) {
        throw Exception('Preview not authorised (sign in again)');
      }
      if (res.statusCode != 201) throw Exception('Preview unavailable (${res.statusCode})');
      // MediaMTX returns "/<path>/whep/<secret>". Behind the /webrtc reverse-proxy prefix an
      // absolute path would miss MediaMTX, so build the session URL from the endpoint instead.
      final location = res.headers['location'];
      if (location != null && location.isNotEmpty) _session = Uri.parse('$url/${location.split('/').last}');
      await pc.setRemoteDescription(RTCSessionDescription(res.body, 'answer'));
    } on Object catch (e) {
      if (gen == _generation) _fail(e.toString().replaceFirst('Exception: ', ''));
    }
  }

  void _fail(String message) {
    if (!mounted) return;
    setState(() {
      _connecting = false;
      _hasVideo = false;
      _error = message;
    });
    _retry?.cancel();
    final gen = _generation;
    _retry = Timer(const Duration(seconds: 3), () {
      if (mounted && gen == _generation) _connect();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        const ColoredBox(color: Colors.black),
        if (!_hasVideo && widget.placeholder != null) widget.placeholder!,
        if (_rendererReady)
          Opacity(
            opacity: _hasVideo ? 1 : 0,
            child: RTCVideoView(_renderer, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain),
          ),
        if (widget.url != null && !_hasVideo)
          Center(
            child: _connecting
                ? const SizedBox(width: 26, height: 26, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Text(_error ?? '', style: const TextStyle(color: Colors.white70, fontSize: 12)),
          ),
      ],
    );
  }
}
