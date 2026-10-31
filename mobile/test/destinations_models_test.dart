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

  test('V7 watch player: Go live label, active count, state', () {
    final o = OutputsState.fromJson({
      'relay': true,
      'platforms': [
        {'platform': 'youtube', 'configured': true, 'enabled': true},
      ],
      'watch': {'enabled': true, 'state': 'live', 'since': null, 'error': null},
    });
    expect(o.watchActive, isTrue);
    expect(o.watch!.live, isTrue);
    expect(o.activeCount, 2);
    expect(o.goLiveLabel, 'Go live: Watch page + YouTube');
    final only = OutputsState.fromJson({'relay': true, 'watch': {'enabled': true, 'state': 'off'}});
    expect(only.goLiveLabel, 'Go live on the watch page', reason: 'not "on YouTube" when YouTube is not set up');
    final off = OutputsState.fromJson({'relay': false, 'watch': {'enabled': false, 'state': 'off'}});
    expect([off.watchActive, off.goLiveLabel], [false, 'Go live on YouTube']);
    final old = OutputsState.fromJson({'relay': false});
    expect(old.watch, isNull, reason: 'older servers send no watch block');
  });

  test('V7 watch info: live link, replays, embed', () {
    final w = WatchInfo.fromJson({
      'available': true,
      'enabled': true,
      'watchPage': 'https://live.gogetslive.com/watch/t1',
      'publicWatch': true,
      'watch': {
        'live': null,
        'embedUrl': 'https://live.gogetslive.com/embed/t1',
        'replays': [
          {'url': 'https://gogetslive.b-cdn.net/hls/t1/s1/replay.m3u8', 'startedAt': '2026-10-31T08:00:00Z', 'durationSec': 4800},
          {'url': 'https://gogetslive.b-cdn.net/hls/t1/s0/replay.m3u8', 'startedAt': '2026-10-30T08:00:00Z', 'durationSec': 1500},
        ],
      },
    });
    expect([w.available, w.live, w.embedUrl], [true, null, 'https://live.gogetslive.com/embed/t1']);
    expect(w.replays.map((r) => r.lengthLabel), ['1 h 20 min', '25 min']);
    expect(w.replays.first.startedAt.toUtc(), DateTime.utc(2026, 10, 31, 8));
  });
}
