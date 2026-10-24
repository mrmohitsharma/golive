import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/api.dart';
import '../core/session.dart';

/// Broadcast colours: red = on air (programme), green = preview, amber = warning.
class Broadcast {
  static const onAir = Color(0xFFE53935);
  static const preview = Color(0xFF43A047);
  static const warning = Color(0xFFFFB300);
  static const offline = Color(0xFF757575);
  static const panel = Color(0xFF15191C);
  static const panelHigh = Color(0xFF1F2529);
  static const course = Color(0xFF1D3B2A);
}

class InfoBanner extends StatelessWidget {
  const InfoBanner({super.key, required this.icon, required this.text, this.error = false});
  final IconData icon;
  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bg = error ? scheme.errorContainer : scheme.surfaceContainerHighest;
    final fg = error ? scheme.onErrorContainer : scheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: fg, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: TextStyle(color: fg))),
        ],
      ),
    );
  }
}

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, required this.color, this.icon, this.dense = false});
  final String label;
  final Color color;
  final IconData? icon;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 6 : 10, vertical: dense ? 2 : 5),
      decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(6)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: dense ? 12 : 15, color: Colors.white),
            SizedBox(width: dense ? 3 : 5),
          ],
          Text(
            label,
            style: TextStyle(
              color: Colors.white,
              fontWeight: FontWeight.w700,
              fontSize: dense ? 10.5 : 12.5,
              letterSpacing: 0.4,
            ),
          ),
        ],
      ),
    );
  }
}

class SignOutButton extends StatelessWidget {
  const SignOutButton({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final guest = session.isGuest;
    return IconButton(
      tooltip: guest ? 'Leave this tournament' : 'Sign out (${session.user?.email ?? ''})',
      icon: const Icon(Icons.logout),
      onPressed: () async {
        final ok = await confirm(
          context,
          title: guest ? 'Leave this tournament?' : 'Sign out?',
          message: guest
              ? 'Any live stream or commentary from this device will stop. You can join again with the same code.'
              : 'Any live stream from this device will stop.',
          action: guest ? 'Leave' : 'Sign out',
        );
        if (ok) {
          await session.signOut();
          if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
        }
      },
    );
  }
}

Future<bool> confirm(BuildContext context, {required String title, required String message, String action = 'OK', bool destructive = false}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(
          style: destructive ? FilledButton.styleFrom(backgroundColor: Broadcast.onAir) : null,
          onPressed: () => Navigator.pop(c, true),
          child: Text(action),
        ),
      ],
    ),
  );
  return ok == true;
}

void toast(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message), backgroundColor: error ? Broadcast.onAir : null));
}

Future<void> copyText(BuildContext context, String text, String what) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) toast(context, '$what copied');
}

/// Runs an API call and shows its error as a snackbar. Returns null on failure.
Future<T?> guarded<T>(BuildContext context, Future<T> Function() call) async {
  try {
    return await call();
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.message, error: true);
    return null;
  }
}

/// An image the server only gives to signed-in users (QR codes, clip thumbnails).
class AuthImage extends StatefulWidget {
  const AuthImage({super.key, required this.api, required this.path, this.fit = BoxFit.contain});
  final ApiClient api;
  final String path;
  final BoxFit fit;

  @override
  State<AuthImage> createState() => _AuthImageState();
}

class _AuthImageState extends State<AuthImage> {
  Uint8List? _bytes;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant AuthImage old) {
    super.didUpdateWidget(old);
    if (old.path != widget.path) _load();
  }

  Future<void> _load() async {
    try {
      final (b, _) = await widget.api.bytes(widget.path);
      if (!mounted) return;
      setState(() {
        _bytes = b;
        _failed = b == null;
      });
    } on Object {
      if (mounted) setState(() => _failed = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final b = _bytes;
    if (b != null) return Image.memory(b, fit: widget.fit, gaplessPlayback: true);
    return ColoredBox(
      color: Colors.black26,
      child: Center(
        child: _failed
            ? const Icon(Icons.image_not_supported_outlined, color: Colors.white38)
            : const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
      ),
    );
  }
}

/// Titled card used on the tournament and organisation screens.
class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.icon, required this.title, this.trailing, required this.children});
  final IconData icon;
  final String title;
  final Widget? trailing;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            Icon(icon, size: 20),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: Theme.of(context).textTheme.titleMedium)),
            if (trailing != null) trailing!,
          ]),
          const SizedBox(height: 10),
          ...children,
        ]),
      ),
    );
  }
}

/// Centred, width-limited scrolling page body (phones and tablets).
class PageBody extends StatelessWidget {
  const PageBody({super.key, required this.children, this.maxWidth = 720, this.onRefresh});
  final List<Widget> children;
  final double maxWidth;
  final Future<void> Function()? onRefresh;

  @override
  Widget build(BuildContext context) {
    final list = ListView(padding: const EdgeInsets.all(16), physics: const AlwaysScrollableScrollPhysics(), children: children);
    return SafeArea(
      child: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: maxWidth),
          child: onRefresh == null ? list : RefreshIndicator(onRefresh: onRefresh!, child: list),
        ),
      ),
    );
  }
}

String formatDuration(Duration d) {
  final h = d.inHours;
  final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
  final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
  return h > 0 ? '$h:$m:$s' : '$m:$s';
}

String formatKbps(int? kbps) {
  if (kbps == null) return '–';
  if (kbps >= 1000) return '${(kbps / 1000).toStringAsFixed(1)} Mbps';
  return '$kbps kbps';
}

String formatMoney(double v) => v < 10 ? v.toStringAsFixed(2) : v.toStringAsFixed(0);
