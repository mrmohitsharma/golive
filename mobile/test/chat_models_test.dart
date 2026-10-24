import 'package:cogolfer_live/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Shapes copied from GET /api/tournaments/:id/chat (server/test/chat.test.ts).
void main() {
  test('combined chat feed with source status', () {
    final f = ChatFeed.fromJson({
      'enabled': true,
      'slowSec': 3,
      'version': 12,
      'sources': {
        'youtube': {'state': 'reading', 'error': null, 'lastAt': '2026-10-24T06:00:00Z'},
        'facebook': {'state': 'error', 'error': 'Facebook did not allow reading comments.', 'lastAt': null},
      },
      'messages': [
        {'id': 1, 'source': 'watch', 'author': 'Rahul Verma', 'text': 'What club on 7?', 'question': true, 'pinned': true, 'at': '2026-10-24T06:00:00.000Z', 'hidden': false, 'answered': false},
        {'id': 2, 'source': 'youtube', 'author': 'Arjun', 'text': 'Great coverage!', 'question': false, 'pinned': false, 'at': '2026-10-24T06:00:05.000Z', 'hidden': false, 'answered': false},
        {'id': 3, 'source': 'facebook', 'author': 'Priya Nair', 'text': 'Is 18 reachable in two?', 'question': true, 'pinned': false, 'at': '2026-10-24T06:01:00.000Z', 'hidden': true, 'answered': true},
      ],
    })!;
    expect(f.version, 12);
    expect(f.youtube.state, 'reading');
    expect(f.facebook.error, contains('Facebook'));
    expect(f.messages.map((m) => m.source), [ChatSource.watch, ChatSource.youtube, ChatSource.facebook]);
    expect(f.messages.first.pinned, isTrue);
    expect(f.messages.last.hidden && f.messages.last.answered, isTrue);
    expect(ChatSource.facebook.label, 'Facebook');
  });

  test('unchanged reply and graphics question', () {
    expect(ChatFeed.fromJson({'unchanged': true, 'version': 12}), isNull);
    final g = GraphicsState.fromJson({
      'question': {'visible': true, 'author': 'Priya Nair', 'source': 'facebook', 'text': 'Is 18 reachable in two?'},
    });
    expect(g.questionVisible, isTrue);
    expect(g.questionAuthor, 'Priya Nair');
    expect(Tournament.fromJson({'id': 't', 'name': 'x', 'chatEnabled': false, 'chatSlowSec': 10}).chatSlowSec, 10);
  });
}
