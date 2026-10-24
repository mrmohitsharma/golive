import 'package:cogolfer_live/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

// Shapes copied from the server's real responses (server/src/hub.ts cameraDto, protocol.ts).
const cameraJson = {
  'id': '7b0e2c1a-3a52-4d0c-9f1e-1d2f3a4b5c6d',
  'tournamentId': 'f1e2d3c4-0000-4000-8000-000000000001',
  'name': 'Hole 9 Green',
  'hole': 9,
  'position': 'Green',
  'streamPath': 'cam-083d8da2c5',
  'platform': 'ios',
  'deviceModel': 'iPhone (iPhone16,1)',
  'sortOrder': 2,
  'status': 'live',
  'health': {
    'online': true,
    'onlineSince': '2026-10-22T19:30:20Z',
    'inboundKbps': 1637,
    'readers': 2,
    'tracks': ['H264', 'MPEG-4 Audio'],
  },
  'telemetry': {
    'state': 'live',
    'bitrateKbps': 1580,
    'battery': 81,
    'charging': false,
    'appState': 'foreground',
    'receivedAt': '2026-10-22T19:30:21Z',
  },
  'onAir': true,
  'inPreview': false,
  'whepUrl': 'https://live.example.com/webrtc/cam-083d8da2c5/whep',
  'thumbnailUrl': '/api/cameras/7b0e2c1a-3a52-4d0c-9f1e-1d2f3a4b5c6d/thumbnail.jpg',
};

void main() {
  test('parses a live camera with health and telemetry', () {
    final c = CameraInfo.fromJson(Map<String, dynamic>.from(cameraJson));
    expect(c.status, FeedStatus.live);
    expect(c.assignment, 'Hole 9 · Green');
    expect(c.health.online, isTrue);
    expect(c.health.inboundKbps, 1637);
    expect(c.health.tracks, ['H264', 'MPEG-4 Audio']);
    expect(c.telemetry!.battery, 81);
    expect(c.onAir, isTrue);
  });

  test('unknown status falls back to offline; missing hole shows Unassigned', () {
    final c = CameraInfo.fromJson({...cameraJson, 'status': 'weird', 'hole': null, 'position': null, 'telemetry': null});
    expect(c.status, FeedStatus.offline);
    expect(c.assignment, 'Unassigned');
    expect(c.telemetry, isNull);
  });

  test('engine state: switching allowed only when agent and OBS are both connected', () {
    final e = EngineState.fromJson({
      'connected': true,
      'obsConnected': false,
      'programmeCameraId': 'x',
      'streaming': {'active': true, 'reconnecting': false, 'kbps': 6000, 'congestion': 0.05},
    });
    expect(e.canSwitch, isFalse);
    expect(e.streaming.active, isTrue);
    expect(e.streaming.kbps, 6000);
    expect(EngineState.fromJson({'connected': true, 'obsConnected': true}).canSwitch, isTrue);
    expect(EngineState.fromJson(null).connected, isFalse);
  });

  test('telemetry omits nulls when serialised', () {
    const t = CameraTelemetry(state: 'reconnecting', battery: 50);
    expect(t.toJson(), {'state': 'reconnecting', 'battery': 50});
  });

  test('roles and capabilities', () {
    expect(parseRole('director'), TournamentRole.director);
    expect(parseRole('nonsense'), isNull);
    expect(TournamentRole.owner.canDirect && TournamentRole.owner.canCamera, isTrue);
    expect(TournamentRole.scorer.canScore, isTrue);
    expect(TournamentRole.scorer.canDirect || TournamentRole.scorer.canWatch, isFalse);
    expect(TournamentRole.commentator.canWatch && TournamentRole.commentator.canCommentate, isTrue);
    expect(TournamentRole.camera.canCamera && !TournamentRole.camera.canWatch, isTrue);
  });
}
