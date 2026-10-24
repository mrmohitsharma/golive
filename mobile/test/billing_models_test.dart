import 'package:cogolfer_live/core/models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Shapes copied from the server's billing responses (server/test/billing.test.ts).
void main() {
  test('tournament billing: cameras, live minutes, grace', () {
    final b = TournamentBilling.fromJson({
      'enabled': true,
      'suspended': false,
      'suspendedReason': null,
      'balance': 22.5,
      'pricing': {'freeCameras': 2, 'freeMinutes': 10, 'cameraPrice': 100, 'minutePrice': 2.5, 'graceMinutes': 5},
      'cameras': {'free': 2, 'extra': 1, 'limit': 3, 'used': 3, 'price': 100},
      'minutes': {'free': 10, 'liveSeconds': 750, 'billed': 3, 'price': 2.5, 'freeSecondsLeft': 0, 'remainingSeconds': 570},
      'grace': {'active': false, 'secondsLeft': null},
      'canGoLive': true,
      'reason': null,
    });
    expect([b.cameraLimit, b.camerasUsed, b.camerasExtra, b.freeCameraSlotsLeft], [3, 3, 1, 0]);
    expect(b.remainingMinutes, 9);
    expect(b.low, isTrue);
    expect(b.pricing.minutePrice, 2.5);
    expect(b.graceActive, isFalse);

    final unlimited = TournamentBilling.fromJson({
      'enabled': true,
      'minutes': {'remainingSeconds': null, 'freeSecondsLeft': 600},
      'grace': {'active': true, 'secondsLeft': 240},
      'canGoLive': false,
      'reason': 'No live minutes left',
    });
    expect(unlimited.remainingMinutes, isNull);
    expect(unlimited.low, isFalse);
    expect(unlimited.graceSecondsLeft, 240);
    expect(unlimited.canGoLive, isFalse);
    expect(const TournamentBilling().enabled, isFalse);
  });

  test('club wallet, packs and history', () {
    final o = OrgBilling.fromJson({
      'enabled': true,
      'balance': 1145,
      'pricing': {'freeCameras': 2, 'freeMinutes': 10, 'cameraPrice': 100, 'minutePrice': 2.5, 'graceMinutes': 5},
      'packs': [
        {'id': 'p500', 'label': 'Starter', 'priceInr': 500, 'credits': 500},
        {'id': 'p1000', 'label': 'Club', 'priceInr': 1000, 'credits': 1100},
      ],
      'paymentsEnabled': true,
      'suspended': false,
      'details': null,
      'transactions': [
        {'id': 3, 'kind': 'minutes', 'credits': -5, 'quantity': 2, 'tournamentName': 'Monsoon Open', 'note': 'Live minutes', 'at': '2026-10-24T05:12:00.000Z'},
        {'id': 2, 'kind': 'cameras', 'credits': -100, 'quantity': 1, 'tournamentName': 'Monsoon Open', 'at': '2026-10-24T05:01:00.000Z'},
        {'id': 1, 'kind': 'admin', 'credits': 150, 'note': 'Launch offer', 'at': '2026-10-24T05:00:00.000Z'},
      ],
    });
    expect(o.packs[1].bonusPercent, 10);
    expect(o.packs[0].bonusPercent, 0);
    expect(o.details, isNull);
    expect(o.transactions.map((t) => t.title), ['Live minutes (2)', 'Extra camera', 'Launch offer']);
    expect(o.transactions.first.credits, -5);
  });

  test('payment status and amount formatting', () {
    final p = PaymentInfo.fromJson({'id': 'x', 'status': 'paid', 'amountInr': 1000, 'credits': 1100});
    expect(p.status, PaymentStatus.paid);
    expect(formatAmount(1100), '1,100');
    expect(formatAmount(2.5), '2.5');
    expect(formatAmount(150000), '1,50,000');
    expect(formatAmount(-5), '-5');
    expect(formatAmount(1234567.25), '12,34,567.25');
  });
}
