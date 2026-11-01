import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../ui/widgets.dart';

/// Which screen edge an [EdgeArc] sits on.
enum ArcSide { left, right }

/// A curved slider along a screen edge, used with the thumb: brightness on the left,
/// zoom on the right. Drag up / down along the arc; double-tap resets.
class EdgeArc extends StatefulWidget {
  const EdgeArc({
    super.key,
    required this.side,
    required this.value,
    required this.onChanged,
    required this.label,
    required this.icon,
    required this.title,
    this.ticks = const [],
    this.fillFrom = 0,
    this.onReset,
    this.enabled = true,
    this.height = 240,
  });

  final ArcSide side;

  /// 0 (bottom) .. 1 (top).
  final double value;
  final ValueChanged<double> onChanged;

  /// Shown in the thumb (e.g. "1.4×", "+0.7").
  final String label;
  final IconData icon;

  /// Accessibility label (e.g. "Brightness").
  final String title;

  /// Marks along the arc: (position 0..1, text).
  final List<(double, String)> ticks;

  /// Where the coloured part starts: 0 = bottom (zoom), 0.5 = middle (brightness).
  final double fillFrom;
  final VoidCallback? onReset;
  final bool enabled;
  final double height;

  static const double width = 84;

  @override
  State<EdgeArc> createState() => _EdgeArcState();
}

class _EdgeArcState extends State<EdgeArc> {
  bool _dragging = false;

  void _drag(DragUpdateDetails d) {
    if (!widget.enabled) return;
    // A full sweep of the arc is about 85% of its height.
    final next = (widget.value - d.delta.dy / (widget.height * 0.85)).clamp(0.0, 1.0);
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: widget.title,
      value: widget.label,
      slider: true,
      onIncrease: widget.enabled ? () => widget.onChanged((widget.value + 0.05).clamp(0.0, 1.0)) : null,
      onDecrease: widget.enabled ? () => widget.onChanged((widget.value - 0.05).clamp(0.0, 1.0)) : null,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onVerticalDragStart: (_) => setState(() => _dragging = true),
        onVerticalDragUpdate: _drag,
        onVerticalDragEnd: (_) => setState(() => _dragging = false),
        onVerticalDragCancel: () => setState(() => _dragging = false),
        onDoubleTap: widget.enabled ? widget.onReset : null,
        child: SizedBox(
          width: EdgeArc.width,
          height: widget.height,
          child: CustomPaint(
            painter: _ArcPainter(
              side: widget.side,
              value: widget.value,
              label: widget.label,
              icon: widget.icon,
              ticks: widget.ticks,
              fillFrom: widget.fillFrom,
              active: _dragging,
              enabled: widget.enabled,
            ),
          ),
        ),
      ),
    );
  }
}

class _ArcPainter extends CustomPainter {
  _ArcPainter({
    required this.side,
    required this.value,
    required this.label,
    required this.icon,
    required this.ticks,
    required this.fillFrom,
    required this.active,
    required this.enabled,
  });

  final ArcSide side;
  final double value;
  final String label;
  final IconData icon;
  final List<(double, String)> ticks;
  final double fillFrom;
  final bool active;
  final bool enabled;

  static const double _apex = 30; // distance of the arc's middle from the screen edge

  @override
  void paint(Canvas canvas, Size size) {
    final h = size.height;
    final r = h * 0.8;
    final sweep = 2 * math.asin(math.min(0.95, (h / 2 - 22) / r));
    final left = side == ArcSide.left;
    final c = left ? Offset(_apex - r, h / 2) : Offset(size.width - _apex + r, h / 2);
    // value 1 = top of the arc.
    double angle(double v) => sweep / 2 - v * sweep;
    Offset at(double v, [double radius = 0]) {
      final a = angle(v);
      final rr = r + radius;
      return left ? c + Offset(rr * math.cos(a), rr * math.sin(a)) : c + Offset(-rr * math.cos(a), rr * math.sin(a));
    }

    final rect = Rect.fromCircle(center: c, radius: r);
    // Canvas angles: right side arcs sit around pi.
    double canvasAngle(double v) => left ? angle(v) : math.pi - angle(v);
    final track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round
      ..color = Colors.white.withValues(alpha: enabled ? 0.28 : 0.12);
    canvas.drawArc(rect, canvasAngle(1), canvasAngle(0) - canvasAngle(1), false, track);

    if (enabled) {
      final fill = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round
        ..color = Broadcast.warning;
      final a0 = canvasAngle(fillFrom), a1 = canvasAngle(value);
      canvas.drawArc(rect, a0, a1 - a0, false, fill);
    }

    // Ticks and their labels (inside, toward the middle of the screen).
    final tick = Paint()
      ..strokeWidth = 2
      ..color = Colors.white.withValues(alpha: 0.6);
    for (final (v, text) in ticks) {
      canvas.drawLine(at(v, -6), at(v, 6), tick);
      if (text.isEmpty) continue;
      final tp = _text(text, 11, Colors.white70, FontWeight.w600);
      final p = at(v, 16);
      tp.paint(canvas, Offset(left ? p.dx : p.dx - tp.width, p.dy - tp.height / 2));
    }

    // Icon at the top end of the arc.
    final ip = _icon(icon, 18, Colors.white.withValues(alpha: enabled ? 0.9 : 0.4));
    final top = at(1, 0);
    ip.paint(canvas, Offset(top.dx - ip.width / 2, top.dy - ip.height - 8));

    // Thumb with the value.
    final t = at(value);
    canvas.drawCircle(t, active ? 21 : 18, Paint()..color = Colors.black.withValues(alpha: 0.75));
    canvas.drawCircle(
      t,
      active ? 21 : 18,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = enabled ? Broadcast.warning : Colors.white24,
    );
    final lp = _text(label, 11.5, Colors.white, FontWeight.w800);
    lp.paint(canvas, t - Offset(lp.width / 2, lp.height / 2));
  }

  TextPainter _text(String s, double size, Color color, FontWeight weight) => TextPainter(
        text: TextSpan(text: s, style: TextStyle(fontSize: size, color: color, fontWeight: weight)),
        textDirection: TextDirection.ltr,
      )..layout();

  TextPainter _icon(IconData i, double size, Color color) => TextPainter(
        text: TextSpan(
          text: String.fromCharCode(i.codePoint),
          style: TextStyle(fontSize: size, color: color, fontFamily: i.fontFamily, package: i.fontPackage),
        ),
        textDirection: TextDirection.ltr,
      )..layout();

  @override
  bool shouldRepaint(_ArcPainter o) =>
      o.value != value || o.label != label || o.active != active || o.enabled != enabled || o.ticks.length != ticks.length || o.side != side;
}

// ---------------------------------------------------------------- value <-> arc position
/// Zoom moves on a log scale, so 0.5x -> 1x takes as much thumb travel as 1x -> 2x.
double zoomToArc(double z, double min, double max) {
  if (max <= min) return 0;
  return (math.log(z / min) / math.log(max / min)).clamp(0.0, 1.0);
}

double arcToZoom(double v, double min, double max) => max <= min ? min : min * math.pow(max / min, v);

String zoomLabel(double z) => z < 10 ? '${z.toStringAsFixed(1)}×' : '${z.round()}×';

String evLabel(double ev) => ev.abs() < 0.05 ? '0' : '${ev > 0 ? '+' : '−'}${ev.abs().toStringAsFixed(1)}';

/// Zoom shortcuts: 0.5× · 1× · 2× · 5× (those the camera can do).
class ZoomPresets extends StatelessWidget {
  const ZoomPresets({super.key, required this.zoom, required this.min, required this.max, required this.onPick, this.enabled = true});

  final double zoom;
  final double min;
  final double max;
  final ValueChanged<double> onPick;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final presets = [0.5, 1.0, 2.0, 5.0].where((p) => p >= min - 0.05 && p <= max + 0.05).toList();
    if (presets.length < 2) return const SizedBox.shrink();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final p in presets.reversed)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: _RoundChip(
              text: p == 0.5 ? '.5' : '${p.round()}',
              on: (zoom - p).abs() < 0.06,
              onTap: enabled ? () => onPick(p) : null,
              semantics: 'Zoom ${p == 0.5 ? '0.5' : p.round()} times',
            ),
          ),
      ],
    );
  }
}

class _RoundChip extends StatelessWidget {
  const _RoundChip({required this.text, required this.on, required this.onTap, required this.semantics});
  final String text;
  final bool on;
  final VoidCallback? onTap;
  final String semantics;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: semantics,
        child: GestureDetector(
          onTap: onTap,
          child: Container(
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.black.withValues(alpha: 0.6),
              border: Border.all(color: on ? Broadcast.warning : Colors.white30, width: on ? 2 : 1),
            ),
            child: Text(
              text,
              style: TextStyle(color: on ? Broadcast.warning : Colors.white, fontWeight: FontWeight.w800, fontSize: 12.5),
            ),
          ),
        ),
      );
}

/// The yellow square where the operator tapped (focus), with "LOCK" after a long-press.
class FocusMarker extends StatelessWidget {
  const FocusMarker({super.key, required this.locked});
  final bool locked;

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: 1.35, end: 1),
        duration: const Duration(milliseconds: 220),
        builder: (context, s, child) => Transform.scale(scale: s, child: child),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(border: Border.all(color: Broadcast.warning, width: 1.5)),
            ),
            if (locked)
              Container(
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                color: Broadcast.warning,
                child: const Text('LOCK', style: TextStyle(color: Colors.black, fontSize: 10, fontWeight: FontWeight.w900)),
              ),
          ],
        ),
      );
}

/// Microphone button with its level: green / amber / red bar so the operator sees sound is
/// coming in. Tap to mute (MIC OFF, red) or unmute.
class MicMeter extends StatelessWidget {
  const MicMeter({super.key, required this.level, this.muted = false, this.onTap});
  final ValueNotifier<double> level;
  final bool muted;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: muted ? 'Microphone off. Tap to turn it on' : 'Microphone on. Tap to mute',
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: muted ? Broadcast.onAir : Colors.black54,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(muted ? Icons.mic_off : Icons.mic, size: 18, color: Colors.white),
              const SizedBox(width: 6),
              if (muted)
                const Text('MIC OFF', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12.5))
              else
                ValueListenableBuilder<double>(
                  valueListenable: level,
                  builder: (context, l, _) {
                    // Shown in decibels (-60 dB .. 0 dB) so quiet speech still moves the bar.
                    final db = l <= 0.001 ? -60.0 : 20 * math.log(l) / math.ln10;
                    final f = ((db + 60) / 60).clamp(0.0, 1.0);
                    final color = f > 0.92 ? Broadcast.onAir : (f > 0.75 ? Broadcast.warning : Broadcast.preview);
                    return Container(
                      width: 54,
                      height: 6,
                      decoration: BoxDecoration(color: Colors.white12, borderRadius: BorderRadius.circular(3)),
                      alignment: Alignment.centerLeft,
                      child: FractionallySizedBox(
                        widthFactor: f,
                        child: Container(decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3))),
                      ),
                    );
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Live for 12:34": ticks by itself, so the rest of the camera screen isn't redrawn every second.
class LiveClock extends StatefulWidget {
  const LiveClock({super.key, required this.since, required this.builder});
  final DateTime since;
  final Widget Function(Duration) builder;

  @override
  State<LiveClock> createState() => _LiveClockState();
}

class _LiveClockState extends State<LiveClock> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) => setState(() {}));
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(DateTime.now().difference(widget.since));
}

/// Small round tool button (AF, light, portrait…) with a short label under the icon.
class ToolButton extends StatelessWidget {
  const ToolButton({super.key, required this.icon, required this.label, required this.onTap, this.on = false, this.onLongPress});
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool on;

  @override
  Widget build(BuildContext context) => Semantics(
        button: true,
        label: label,
        child: GestureDetector(
          onTap: onTap,
          onLongPress: onLongPress,
          child: Opacity(
            opacity: onTap == null && onLongPress == null ? 0.4 : 1,
            child: Container(
              height: 40,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              decoration: BoxDecoration(
                color: on ? Broadcast.warning : Colors.black54,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                Icon(icon, size: 18, color: on ? Colors.black : Colors.white),
                const SizedBox(width: 5),
                Text(label, style: TextStyle(color: on ? Colors.black : Colors.white, fontWeight: FontWeight.w700, fontSize: 12.5)),
              ]),
            ),
          ),
        ),
      );
}
