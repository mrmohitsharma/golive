import 'package:cogolfer_live/core/join_link.dart';
import 'package:cogolfer_live/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('join links (QR poster)', () {
    test('full poster URL gives server and code', () {
      final l = parseJoinLink('https://live.dlfgolf.com/join/ABC123')!;
      expect(l.server, 'https://live.dlfgolf.com');
      expect(l.code, 'ABC123');
    });

    test('server behind a path prefix, trailing slash, query', () {
      final l = parseJoinLink('https://club.example/live/join/abc-123/?utm=poster')!;
      expect(l.server, 'https://club.example/live');
      expect(l.code, 'ABC123');
    });

    test('http and ports are kept (local test servers)', () {
      expect(parseJoinLink('http://192.168.1.20:8080/join/K7Q2MX')!.server, 'http://192.168.1.20:8080');
    });

    test('link without scheme defaults to https', () {
      expect(parseJoinLink('live.club.in/join/ZZ99AA')!.server, 'https://live.club.in');
    });

    test('bare codes typed by hand, with dashes and spaces', () {
      final l = parseJoinLink('  abc-123 ')!;
      expect(l.server, isNull);
      expect(l.code, 'ABC123');
      expect(parseJoinLink('abc 123')!.code, 'ABC123');
    });

    test('rejects junk', () {
      expect(parseJoinLink(''), isNull);
      expect(parseJoinLink('ab'), isNull);
      expect(parseJoinLink('https://example.com/some/page'), isNull);
      expect(parseJoinLink('WIFI:S:clubhouse;T:WPA;P:secret;;'), isNull);
    });

    test('normalisation matches the server', () {
      expect(normaliseJoinCode('ab-c 1_2.3'), 'ABC123');
    });
  });

  test('tournament from the list endpoint (role, mode, org)', () {
    final t = Tournament.fromJson({
      'id': 't1',
      'orgId': 'o1',
      'orgName': 'DLF',
      'name': 'Monsoon Open',
      'venue': 'DLF Golf',
      'mode': 'cloud',
      'autoFallback': false,
      'archived': false,
      'hasYoutubeBroadcast': true,
      'role': 'director',
    });
    expect(t.mode, ProductionMode.cloud);
    expect(t.role, TournamentRole.director);
    expect(t.title, 'Monsoon Open · DLF Golf');
    expect(t.copyWith(role: TournamentRole.owner).role, TournamentRole.owner);
  });

  test('guest pass round-trips through storage', () {
    final g = GuestPass.fromJson({
      'id': 'g1',
      'name': 'Ravi',
      'role': 'scorer',
      'tournament': {'id': 't1', 'name': 'Open', 'venue': null, 'role': 'scorer'},
    });
    final again = GuestPass.fromJson(g.toJson());
    expect(again.role, TournamentRole.scorer);
    expect(again.tournament.id, 't1');
    expect(again.tournament.role, TournamentRole.scorer);
  });

  test('join code display and expiry', () {
    final c = JoinCode.fromJson({
      'code': 'K7Q2MX',
      'role': 'camera',
      'label': null,
      'uses': 3,
      'expiresAt': '2026-10-24T10:00:00.000Z',
      'joinUrl': 'https://x/join/K7Q2MX',
      'qrUrl': '/api/tournaments/t/join-codes/K7Q2MX/qr.png',
    });
    expect(c.display, 'K7Q-2MX');
    expect(c.uses, 3);
    expect(c.expiresAt!.isUtc, isTrue);
  });

  test('production state and running cost', () {
    final p = ProductionState.fromJson({
      'mode': 'cloud',
      'cloudAvailable': true,
      'cloud': {'status': 'running', 'startedAt': '2026-10-23T10:00:00.000Z', 'error': null, 'costPerHour': 0.4, 'autoStopAfterIdleMin': 20},
    });
    expect(p.cloudStatus, CloudEngineStatus.running);
    expect(p.costSoFar(DateTime.utc(2026, 10, 23, 12, 30)), closeTo(1.0, 1e-9));
    expect(ProductionState.fromJson({'mode': 'laptop', 'cloud': {'status': 'weird'}}).cloudStatus, CloudEngineStatus.stopped);
    expect(const ProductionState().costSoFar(DateTime.now()), 0);
  });

  test('YouTube lifecycle in plain words', () {
    expect(const YoutubeState().statusLabel, 'No broadcast');
    expect(YoutubeState.fromJson({'broadcastId': 'b', 'lifeCycleStatus': 'liveStarting'}).statusLabel, 'Starting');
    expect(YoutubeState.fromJson({'broadcastId': 'b', 'lifeCycleStatus': 'live'}).statusLabel, 'Live');
    expect(YoutubeState.fromJson({'broadcastId': 'b', 'issues': ['Low bitrate']}).issues, ['Low bitrate']);
  });

  test('engine state carries replay and warnings', () {
    final e = EngineState.fromJson({
      'connected': true,
      'obsConnected': true,
      'replayActive': true,
      'warnings': ['This OBS has no Browser Source'],
    });
    expect(e.replayActive, isTrue);
    expect(e.warnings.single, contains('Browser Source'));
  });

  test('graphics and audio state', () {
    final g = GraphicsState.fromJson({
      'lowerThird': {'visible': true, 'playerId': 'p1', 'title': '', 'subtitle': ''},
      'holeCard': {'auto': false, 'visible': true, 'hole': 7, 'durationSec': 8},
      'leaderboard': {'visible': true, 'size': 5, 'category': 'Ladies'},
      'scoreBug': {'visible': false},
      'replay': true,
    });
    expect(g.lowerThirdPlayerId, 'p1');
    expect(g.holeCardHole, 7);
    expect(g.leaderboardCategory, 'Ladies');
    expect(g.scoreBugVisible, isFalse);
    expect(GraphicsState.fromJson(null).scoreBugVisible, isTrue);

    final a = AudioState.fromJson({
      'courseDb': -6,
      'courseMuted': false,
      'cameras': {
        'c1': {'db': -3, 'muted': true},
      },
      'commentaryDb': 2,
      'commentaryMuted': false,
      'ducking': false,
      'commentaryDelayMs': 300,
    });
    expect(a.courseDb, -6);
    expect(a.camera('c1').muted, isTrue);
    expect(a.camera('unknown').db, 0);
    expect(a.ducking, isFalse);
    expect(a.commentaryDelayMs, 300);
  });

  test('leaderboard scores are keyed by hole number', () {
    final r = LeaderboardRow.fromJson({
      'playerId': 'p1',
      'name': 'Aman Sharma',
      'position': 'T2',
      'toPar': -1,
      'toParText': '-1',
      'thru': '3',
      'strokes': 11,
      'scores': {'1': 4, '2': 3, '3': 4},
    });
    expect(r.scores[2], 3);
    expect(r.position, 'T2');
  });

  test('clips: files only when ready, headline fallback', () {
    final working = HighlightClip.fromJson({'id': 'k', 'tournamentId': 't', 'cameraName': 'Hole 7 Green', 'hole': 7, 'status': 'processing', 'durationSec': 30});
    expect(working.working, isTrue);
    expect(working.headline, 'Hole 7 Green · Hole 7');
    expect(working.thumbPath, isNull);
    final ready = HighlightClip.fromJson({
      'id': 'k',
      'tournamentId': 't',
      'title': 'Birdie on 7!',
      'status': 'ready',
      'durationSec': 30,
      'files': {'landscape': '/api/clips/k/landscape.mp4', 'vertical': '/api/clips/k/vertical.mp4', 'thumb': '/api/clips/k/thumb.jpg'},
    });
    expect(ready.working, isFalse);
    expect(ready.headline, 'Birdie on 7!');
    expect(ready.verticalPath, endsWith('vertical.mp4'));
  });

  test('commentator OBS input name matches the agent', () {
    final c = Commentator.fromJson({'id': 'm', 'name': 'Vik', 'streamPath': 'com-1', 'online': true});
    expect(c.obsInput, 'CG Commentary com-1');
  });

  test('streaming platforms state from the server', () {
    final o = OutputsState.fromJson({
      'relay': true,
      'platforms': [
        {'platform': 'youtube', 'configured': true, 'enabled': true, 'state': 'live', 'since': '2026-10-24T10:00:00Z', 'error': null, 'link': 'https://www.youtube.com/watch?v=b', 'hint': null},
        {'platform': 'facebook', 'configured': true, 'enabled': true, 'state': 'retrying', 'error': 'The platform closed the connection', 'link': 'https://www.facebook.com/x/videos/1/', 'hint': null},
        {'platform': 'instagram', 'configured': true, 'enabled': false, 'state': 'off', 'hint': '9876'},
      ],
    });
    expect(o.relay, isTrue);
    expect(o.of(StreamPlatform.youtube).live, isTrue);
    expect(o.of(StreamPlatform.facebook).error, contains('closed'));
    expect(o.active.map((p) => p.platform), [StreamPlatform.youtube, StreamPlatform.facebook]);
    expect(o.of(StreamPlatform.instagram).hint, '9876');
    expect(const OutputsState().of(StreamPlatform.instagram).configured, isFalse);
    expect(StreamPlatform.instagram.label, 'Instagram');
  });

  test('Facebook connection with several Pages', () {
    final f = OrgFacebook.fromJson({
      'enabled': true,
      'connected': true,
      'userName': 'Club Admin',
      'pages': [
        {'id': 'p1', 'name': 'DLF Golf'},
        {'id': 'p2', 'name': 'Other'},
      ],
      'pageId': null,
      'pageName': null,
    });
    expect(f.pages.map((p) => p.name), ['DLF Golf', 'Other']);
    expect(f.pageId, isNull);
  });

  test('public watch flags', () {
    expect(Tournament.fromJson({'id': 't', 'name': 'x', 'publicWatch': false}).publicWatch, isFalse);
    expect(Tournament.fromJson({'id': 't', 'name': 'x'}).publicWatch, isTrue);
    expect(HighlightClip.fromJson({'id': 'k', 'tournamentId': 't', 'status': 'ready', 'public': false}).isPublic, isFalse);
  });
}
