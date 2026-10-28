import 'package:cogolfer_live/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('outputs with extra destinations: counts and Go live label', () {
    final o = OutputsState.fromJson({
      'relay': true,
      'platforms': [
        {'platform': 'youtube', 'configured': true, 'enabled': true, 'state': 'live'},
        {'platform': 'facebook', 'configured': false, 'enabled': false},
        {'platform': 'instagram', 'configured': true, 'enabled': true, 'hint': '1234'},
      ],
      'destinations': [
        {'id': 'd1', 'kind': 'channel', 'platform': 'youtube', 'label': 'Sponsor TV', 'enabled': true, 'ready': true, 'privacy': 'unlisted', 'state': 'live', 'link': 'https://www.youtube.com/watch?v=bc-2'},
        {'id': 'd2', 'kind': 'key', 'platform': 'instagram', 'label': 'Sponsor Instagram', 'enabled': false, 'ready': true, 'hint': '9876', 'vertical': true},
        {'id': 'd3', 'kind': 'key', 'platform': 'other', 'label': 'Club site', 'enabled': true, 'ready': true, 'state': 'retrying', 'error': 'Cannot reach the platform; retrying'},
      ],
    });
    expect(o.destinations.length, 3);
    expect(o.activeDestinations.map((d) => d.id), ['d1', 'd3']);
    expect(o.activeCount, 4);
    expect(o.goLiveLabel, 'Go live: YouTube + Instagram + 2 more');
    final d1 = o.destinations.first;
    expect([d1.isChannel, d1.live, d1.platformLabel], [true, true, 'YouTube']);
    expect(o.destinations[1].vertical, isTrue);
    expect(o.destinations[2].platformLabel, 'Stream key');
  });

  test('Go live label without main platforms', () {
    expect(const OutputsState().goLiveLabel, 'Go live on YouTube');
    final only = OutputsState.fromJson({
      'destinations': [
        {'id': 'd1', 'kind': 'key', 'platform': 'youtube', 'label': 'Other channel', 'enabled': true, 'ready': true},
      ],
    });
    expect(only.goLiveLabel, 'Go live: 1 destination');
  });

  test('billing: destinations included, used and price', () {
    final b = TournamentBilling.fromJson({
      'enabled': true,
      'balance': 120,
      'pricing': {'freeDestinations': 1, 'destinationPrice': 50},
      'destinations': {'free': 1, 'extra': 2, 'limit': 3, 'used': 3, 'price': 50},
    });
    expect([b.destinationsFree, b.destinationsExtra, b.destinationLimit, b.destinationsUsed], [1, 2, 3, 3]);
    expect(b.destinationPrice, 50);
    expect(b.destinationRoom, isFalse);
    expect(b.pricing.freeDestinations, 1);
    expect(const TournamentBilling().destinationRoom, isTrue, reason: 'billing off: no limit');
  });

  test('YouTube channels list', () {
    final c = YoutubeChannel.fromJson({'id': 'main', 'title': 'Club TV', 'main': true});
    expect([c.id, c.title, c.main], ['main', 'Club TV', true]);
  });
}
