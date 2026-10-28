import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../ui/widgets.dart';

/// Full-screen QR to hold up to volunteers' phones.
void showQrFullScreen(BuildContext context, ApiClient api, {required String title, required JoinCode code}) {
  Navigator.of(context).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(backgroundColor: Colors.white, foregroundColor: Colors.black, title: Text(title)),
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Flexible(child: AspectRatio(aspectRatio: 1, child: AuthImage(api: api, path: code.qrUrl))),
              const SizedBox(height: 16),
              Text(code.display, style: const TextStyle(color: Colors.black, fontSize: 40, fontWeight: FontWeight.w800, letterSpacing: 6)),
              const SizedBox(height: 8),
              Text('Scan with the phone camera, or in the Go Live app: Join > Scan QR', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey.shade800)),
            ]),
          ),
        ),
      ),
    ),
  ));
}

Future<void> shareOnWhatsApp(BuildContext context, Invite i) async {
  final ok = await launchUrl(Uri.parse(i.whatsapp), mode: LaunchMode.externalApplication);
  if (!ok) await SharePlus.instance.share(ShareParams(text: i.shareText));
}

/// Top of the event screen: the camera QR, ready to share. Scorer and commentator
/// invites sit underneath. No one has to make a code for a normal event (P1-8).
class InviteCard extends StatelessWidget {
  const InviteCard({super.key, required this.api, required this.eventName, required this.invites, this.onManage});
  final ApiClient api;
  final String eventName;
  final List<Invite> invites;
  final VoidCallback? onManage;

  Invite? _of(TournamentRole r) {
    for (final i in invites) {
      if (i.role == r) return i;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final cam = _of(TournamentRole.camera);
    if (cam == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final others = [for (final r in const [TournamentRole.scorer, TournamentRole.commentator]) ?_of(r)];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            GestureDetector(
              onTap: () => showQrFullScreen(context, api, title: '$eventName · Cameras', code: cam.code),
              child: Container(width: 112, height: 112, color: Colors.white, padding: const EdgeInsets.all(4), child: AuthImage(api: api, path: cam.code.qrUrl)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Add cameras', style: theme.textTheme.titleMedium),
                const SizedBox(height: 2),
                Text('Send this to each phone that will film. They tap the link, type a name and go live.', style: theme.textTheme.bodySmall),
                const SizedBox(height: 6),
                SelectableText(cam.code.display, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: 3)),
              ]),
            ),
          ]),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.icon(onPressed: () => shareOnWhatsApp(context, cam), icon: const Icon(Icons.chat), label: const Text('Share on WhatsApp')),
            OutlinedButton.icon(
              onPressed: () => showQrFullScreen(context, api, title: '$eventName · Cameras', code: cam.code),
              icon: const Icon(Icons.qr_code_2),
              label: const Text('Show QR full screen'),
            ),
          ]),
          if (others.isNotEmpty) ...[
            const Divider(height: 24),
            Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Text('Invite:', style: theme.textTheme.bodySmall),
              for (final i in others)
                ActionChip(
                  avatar: Icon(i.role == TournamentRole.scorer ? Icons.scoreboard : Icons.mic, size: 18),
                  label: Text(i.role == TournamentRole.scorer ? 'Scorer' : 'Commentator'),
                  onPressed: () => shareOnWhatsApp(context, i),
                ),
              if (onManage != null) TextButton(onPressed: onManage, child: const Text('All codes')),
            ]),
          ],
        ]),
      ),
    );
  }
}
