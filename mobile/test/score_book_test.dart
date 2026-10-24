import 'dart:convert';

import 'package:cogolfer_live/core/api.dart';
import 'package:cogolfer_live/core/score_book.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A fake server whose connectivity the test switches on and off.
class FakeServer {
  bool online = true;
  final saved = <Map<String, dynamic>>[];
  final rejectPlayers = <String>{};

  MockClient get client => MockClient((req) async {
        if (!online) throw http.ClientException('Network is unreachable');
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        if (rejectPlayers.contains(body['playerId'])) {
          return http.Response(jsonEncode({'error': {'code': 'player_not_found', 'message': 'Player not found in this tournament.'}}), 404);
        }
        saved.add(body);
        return http.Response(
          jsonEncode({
            'player': {'playerId': body['playerId'], 'name': 'P', 'position': '1', 'toParText': 'E', 'thru': '1', 'scores': {'${body['hole']}': body['strokes']}},
          }),
          200,
        );
      });
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('saves immediately when online and reports the server row', () async {
    final server = FakeServer();
    final book = ScoreBook(api: ApiClient(baseUrl: 'https://x.test', token: 't', client: server.client), tournamentId: 't1');
    final rows = [];
    book.onSaved = rows.add;
    await book.set('p1', 3, 4);
    expect(server.saved.single, {'playerId': 'p1', 'hole': 3, 'strokes': 4});
    expect(book.pendingCount, 0);
    expect(rows, hasLength(1));
    book.dispose();
  });

  test('keeps scores through a dead spot and an app restart, sends in order, latest wins', () async {
    final server = FakeServer()..online = false;
    final api = ApiClient(baseUrl: 'https://x.test', token: 't', client: server.client);
    final book = ScoreBook(api: api, tournamentId: 't1', retryEvery: const Duration(hours: 1));
    await book.set('p1', 5, 5);
    await book.set('p2', 5, 4);
    await book.set('p1', 5, 6); // correction while offline
    expect(book.offline, isTrue);
    expect(book.pendingCount, 2);
    expect(book.pendingFor('p1', 5)!.strokes, 6);
    book.dispose();

    // App killed and reopened with signal back.
    server.online = true;
    final reopened = ScoreBook(api: api, tournamentId: 't1', retryEvery: const Duration(hours: 1));
    await reopened.load();
    expect(reopened.pendingCount, 0);
    expect(server.saved, [
      {'playerId': 'p2', 'hole': 5, 'strokes': 4},
      {'playerId': 'p1', 'hole': 5, 'strokes': 6},
    ]);
    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getString('scores.pending.t1'), isNull);
    reopened.dispose();
  });

  test('rejected entries are dropped and reported, the rest still go', () async {
    final server = FakeServer()..rejectPlayers.add('gone');
    final book = ScoreBook(api: ApiClient(baseUrl: 'https://x.test', token: 't', client: server.client), tournamentId: 't1');
    await book.set('gone', 1, 4);
    await book.set('p1', 1, 3);
    expect(book.pendingCount, 0);
    expect(book.errors.single, contains('Player not found'));
    expect(server.saved.single['playerId'], 'p1');
    book.dispose();
  });

  test('clearing a score sends null', () async {
    final server = FakeServer();
    final book = ScoreBook(api: ApiClient(baseUrl: 'https://x.test', token: 't', client: server.client), tournamentId: 't1');
    await book.set('p1', 2, null);
    expect(server.saved.single['strokes'], isNull);
    book.dispose();
  });

  test('queues are per tournament', () async {
    final server = FakeServer()..online = false;
    final api = ApiClient(baseUrl: 'https://x.test', token: 't', client: server.client);
    final a = ScoreBook(api: api, tournamentId: 'a', retryEvery: const Duration(hours: 1));
    await a.set('p1', 1, 4);
    a.dispose();
    final b = ScoreBook(api: api, tournamentId: 'b', retryEvery: const Duration(hours: 1));
    await b.load();
    expect(b.pendingCount, 0);
    b.dispose();
  });
}
