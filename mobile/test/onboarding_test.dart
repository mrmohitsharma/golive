import 'package:cogolfer_live/core/join_link.dart';
import 'package:cogolfer_live/core/models.dart';
import 'package:cogolfer_live/features/camera/camera_setup_screen.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('website login QR is recognised; join posters are not login links', () {
    final l = parseLoginLink('https://icca.co.in/app/login/AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(l?.server, 'https://icca.co.in');
    expect(l?.code, 'AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(parseLoginLink('https://icca.co.in/join/ABC123'), isNull);
    expect(parseLoginLink('https://icca.co.in/app/login/short'), isNull);
    expect(parseJoinLink('https://icca.co.in/join/ABC123')?.code, 'ABC123');
  });

  test('upload speed picks the camera quality', () {
    expect(presetForKbps(12000), '1080p30');
    expect(presetForKbps(5000), '720p30');
    expect(presetForKbps(2200), '720p25-low');
  });

  test('event profile from the server; volunteers keep it across restarts', () {
    final t = Tournament.fromJson({
      'id': 't1',
      'name': 'Ananya & Rohan',
      'profile': {'id': 'wedding', 'label': 'Wedding', 'positionLabel': null, 'scoring': false, 'captionTitle': 'Names', 'captionSubtitle': 'Occasion'},
    });
    expect([t.profile.id, t.profile.positionLabel, t.profile.scoring, t.profile.captionTitle], ['wedding', null, false, 'Names']);
    final g = GuestPass.fromJson({'id': 'g1', 'name': 'Asha', 'role': 'camera', 'tournament': {'id': 't1', 'name': 'x', 'profile': t.profile.toJson()}});
    final again = GuestPass.fromJson(g.toJson());
    expect(again.tournament.profile.id, 'wedding');
    expect(const Tournament(id: 'x', name: 'old').profile.isGolf, isTrue, reason: 'events made before types are golf');
  });

  test('games list: running when a run is still open', () {
    final soon = DateTime.now().add(const Duration(minutes: 1)).toIso8601String();
    final list = GameMoment.listFromJson({
      'moments': [
        {'id': 'm1', 'type': 'prediction', 'title': 'Birdie?', 'clock': 'director', 'options': [{'id': 'y', 'text': 'Yes'}, {'id': 'n', 'text': 'No'}]},
        {'id': 'm2', 'type': 'spin', 'title': 'Spin', 'clock': 'viewer', 'enabled': false},
      ],
      'runs': [{'momentId': 'm1', 'closesAt': soon}],
    });
    expect([list[0].running, list[0].options.length, list[0].typeLabel], [true, 2, 'Prediction']);
    expect([list[1].running, list[1].enabled], [false, false]);
  });
}
