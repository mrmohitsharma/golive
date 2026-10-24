import 'dart:convert';
import 'dart:math';

import 'package:cogolfer_live/core/api.dart';
import 'package:cogolfer_live/core/models.dart';
import 'package:cogolfer_live/core/realtime.dart';
import 'package:cogolfer_live/core/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('Backoff', () {
    test('grows exponentially, is capped, and resets', () {
      final b = Backoff(base: const Duration(seconds: 1), max: const Duration(seconds: 8), random: Random(1));
      final delays = [for (var i = 0; i < 6; i++) b.next().inMilliseconds];
      expect(delays[0], inInclusiveRange(800, 1200));
      expect(delays[1], inInclusiveRange(1600, 2400));
      expect(delays[2], inInclusiveRange(3200, 4800));
      expect(delays.skip(3).every((d) => d <= 8000 && d >= 6400), isTrue);
      b.reset();
      expect(b.next().inMilliseconds, inInclusiveRange(800, 1200));
    });
  });

  group('ApiClient', () {
    test('maps server errors to code + message', () async {
      final client = MockClient((req) async => http.Response(
            jsonEncode({'error': {'code': 'invalid_credentials', 'message': 'Email or password is incorrect.'}}),
            401,
            headers: {'content-type': 'application/json'},
          ));
      final api = ApiClient(baseUrl: 'https://x.test', client: client);
      expect(
        () => api.login('a@b.c', 'bad'),
        throwsA(isA<ApiException>()
            .having((e) => e.code, 'code', 'invalid_credentials')
            .having((e) => e.isAuth, 'isAuth', true)
            .having((e) => e.message, 'message', 'Email or password is incorrect.')),
      );
    });

    test('sends bearer token and parses camera registration', () async {
      late http.BaseRequest seen;
      final client = MockClient((req) async {
        seen = req;
        return http.Response(
          jsonEncode({
            'camera': {
              'id': 'c1',
              'tournamentId': 't1',
              'name': 'Cam',
              'streamPath': 'cam-1',
              'status': 'offline',
              'whepUrl': 'https://x/webrtc/cam-1/whep',
              'thumbnailUrl': '/api/cameras/c1/thumbnail.jpg',
            },
            'publish': {'srtUrl': 'srt://x:8890?streamid=publish:cam-1:cam:k&latency=600', 'latencyMs': 600},
          }),
          201,
        );
      });
      final api = ApiClient(baseUrl: 'https://x.test/', token: 'tok', client: client);
      final (cam, target) = await api.registerCamera(
        tournamentId: 't1',
        name: 'Cam',
        deviceId: 'android-1234',
        platform: 'android',
      );
      expect(seen.url.toString(), 'https://x.test/api/tournaments/t1/cameras/register');
      expect(seen.headers['Authorization'], 'Bearer tok');
      expect(cam.streamPath, 'cam-1');
      expect(target.srtUrl, startsWith('srt://'));
      expect(target.latencyMs, 600);
    });

    test('non-JSON server errors still produce a readable message', () async {
      final api = ApiClient(baseUrl: 'https://x.test', client: MockClient((_) async => http.Response('<html>502</html>', 502)));
      expect(() => api.tournaments(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'http_502')));
    });
  });

  group('v2 API flows', () {
    test('organiser sign-up returns token, user and their new club', () async {
      late http.Request seen;
      final api = ApiClient(
        baseUrl: 'https://x.test',
        client: MockClient((req) async {
          seen = req;
          return http.Response(
            jsonEncode({
              'token': 'jwt',
              'user': {'id': 'u1', 'email': 'm@club.in', 'name': 'Mohit', 'platformAdmin': false},
              'orgs': [
                {'id': 'o1', 'name': 'DLF Golf', 'role': 'owner'},
              ],
            }),
            201,
          );
        }),
      );
      final s = await api.signup(name: 'Mohit', email: 'm@club.in', password: 'longenough', orgName: 'DLF Golf');
      expect(seen.url.path, '/api/auth/signup');
      expect(jsonDecode(seen.body), {'name': 'Mohit', 'email': 'm@club.in', 'password': 'longenough', 'orgName': 'DLF Golf'});
      expect(s.token, 'jwt');
      expect(s.orgs.single.isOwner, isTrue);
      expect(s.orgs.single.canCreateTournaments, isTrue);
    });

    test('volunteer join gives a tournament-scoped guest pass', () async {
      final api = ApiClient(
        baseUrl: 'https://x.test',
        client: MockClient((req) async => http.Response(
              jsonEncode({
                'token': 'guest-jwt',
                'role': 'commentator',
                'guest': {'id': 'g123', 'name': 'Vik'},
                'tournament': {'id': 't1', 'name': 'Monsoon Open', 'venue': 'DLF'},
              }),
              200,
            )),
      );
      final (token, pass) = await api.join(code: 'ABC123', deviceId: 'android-abcdef12', name: 'Vik');
      expect(token, 'guest-jwt');
      expect(pass.role, TournamentRole.commentator);
      expect(pass.tournament.name, 'Monsoon Open');
      expect(pass.tournament.role, TournamentRole.commentator);
    });

    test('invalid code message comes from the server', () async {
      final api = ApiClient(
        baseUrl: 'https://x.test',
        client: MockClient((_) async => http.Response(
              jsonEncode({'error': {'code': 'invalid_code', 'message': 'That code is not valid. Check it with the organiser.'}}),
              404,
            )),
      );
      expect(() => api.join(code: 'NOPE99', deviceId: 'android-abcdef12', name: 'X'),
          throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid_code')));
    });

    test('replay/clip/graphics/audio requests hit the right endpoints', () async {
      final calls = <String>[];
      final api = ApiClient(
        baseUrl: 'https://x.test',
        token: 't',
        client: MockClient((req) async {
          calls.add('${req.method} ${req.url.path} ${req.body}');
          if (req.url.path.endsWith('/clips')) {
            return http.Response(jsonEncode({'clip': {'id': 'k', 'tournamentId': 't1', 'status': 'queued', 'durationSec': 15}}), 202);
          }
          if (req.url.path.endsWith('/graphics')) return http.Response(jsonEncode({'graphics': {'scoreBug': {'visible': false}}}), 200);
          if (req.url.path.endsWith('/audio')) return http.Response(jsonEncode({'audio': {'courseDb': -6}}), 200);
          return http.Response('{}', 200);
        }),
      );
      final clip = await api.createClip('t1', cameraId: 'c1', secondsBack: 15, durationSec: 15, title: 'Eagle!');
      expect(clip.status, ClipStatus.queued);
      expect((await api.setGraphics('t1', {'scoreBug': {'visible': false}})).scoreBugVisible, isFalse);
      expect((await api.setAudio('t1', {'courseDb': -6})).courseDb, -6);
      expect(calls[0], startsWith('POST /api/tournaments/t1/clips'));
      expect(jsonDecode(calls[0].split(' ').skip(2).join(' ')), {'cameraId': 'c1', 'secondsBack': 15, 'durationSec': 15, 'title': 'Eagle!'});
      expect(calls[1], startsWith('PATCH /api/tournaments/t1/graphics'));
      expect(calls[2], startsWith('PATCH /api/tournaments/t1/audio'));
    });
  });

  test('server address normalisation', () {
    expect(Session.normaliseServer(' live.cogolfers.com/ '), 'https://live.cogolfers.com');
    expect(Session.normaliseServer('http://192.168.1.10:8080'), 'http://192.168.1.10:8080');
  });
}
