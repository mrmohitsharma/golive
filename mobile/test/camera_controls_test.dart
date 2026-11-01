import 'package:cg_streamer/cg_streamer.dart';
import 'package:cogolfer_live/core/models.dart';
import 'package:cogolfer_live/features/camera/camera_controls.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('zoom moves on a log scale along the arc', () {
    expect(zoomToArc(0.5, 0.5, 8), 0);
    expect(zoomToArc(8, 0.5, 8), 1);
    // 0.5x -> 1x takes as much travel as 1x -> 2x.
    expect(zoomToArc(1, 0.5, 8), closeTo(0.25, 1e-9));
    expect(zoomToArc(2, 0.5, 8), closeTo(0.5, 1e-9));
    expect(arcToZoom(0.5, 0.5, 8), closeTo(2, 1e-9));
    expect(zoomToArc(3, 1, 1), 0, reason: 'a camera with no zoom');
  });

  test('labels', () {
    expect(zoomLabel(0.5), '0.5×');
    expect(zoomLabel(12), '12×');
    expect(evLabel(0.02), '0');
    expect(evLabel(0.7), '+0.7');
    expect(evLabel(-1), '−1.0');
  });

  test('camera capabilities from the native side, with bad ranges made safe', () {
    final c = CameraCaps.fromMap({'zoomMin': 0.5, 'zoomMax': 10, 'evMin': -2, 'evMax': 2, 'evStep': 0.1667, 'torch': true, 'lensSwitch': true});
    expect([c.zoomMin, c.zoomMax, c.evMin, c.evMax, c.torch, c.lensSwitch, c.manualFocus], [0.5, 10, -2, 2, true, true, false]);
    final bad = CameraCaps.fromMap({'zoomMin': 2, 'zoomMax': 1, 'evStep': 0});
    expect([bad.zoomMin, bad.zoomMax, bad.evStep], [2, 2, 0.1]);
    expect(const StreamConfig().copyWith(portrait: true).toMap()['portrait'], true);
  });

  test('telemetry carries MIC OFF and ON A CALL to the control room', () {
    const t = CameraTelemetry(state: 'live', micMuted: true, inCall: true);
    final back = CameraTelemetry.fromJson(t.toJson())!;
    expect([back.micMuted, back.inCall], [true, true]);
    expect(CameraTelemetry.fromJson({'state': 'live'})!.micMuted, isNull);
  });
}
