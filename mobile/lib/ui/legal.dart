import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Pages on the server's public website that app stores and Google/Meta reviews ask for.
enum LegalPage { terms, privacy, deleteAccount }

extension LegalPageX on LegalPage {
  String get path => switch (this) {
        LegalPage.terms => '/terms',
        LegalPage.privacy => '/privacy',
        LegalPage.deleteAccount => '/delete-account',
      };
  String get label => switch (this) {
        LegalPage.terms => 'Terms of service',
        LegalPage.privacy => 'Privacy policy',
        LegalPage.deleteAccount => 'Delete your account',
      };
}

/// Opens a legal page of [serverUrl] in the browser.
Future<void> openLegal(BuildContext context, String serverUrl, LegalPage page) async {
  final base = serverUrl.trim().replaceAll(RegExp(r'/+$'), '');
  final uri = Uri.tryParse('$base${page.path}');
  final ok = uri != null && uri.hasScheme && await launchUrl(uri, mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Enter the server address first, then try again.')));
  }
}

/// "By creating an account you agree to the Terms of service and Privacy policy."
class LegalConsent extends StatelessWidget {
  const LegalConsent({super.key, required this.serverUrl});
  final String Function() serverUrl;

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    Widget link(LegalPage p) => InkWell(
          onTap: () => openLegal(context, serverUrl(), p),
          child: Text(p.label, style: small?.copyWith(decoration: TextDecoration.underline, fontWeight: FontWeight.w600)),
        );
    return Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text('By creating an account you agree to the ', style: small),
        link(LegalPage.terms),
        Text(' and confirm you have read the ', style: small),
        link(LegalPage.privacy),
        Text('. You must be 18 or older.', style: small),
      ],
    );
  }
}

/// Terms and Privacy links for the bottom of a screen.
class LegalFooter extends StatelessWidget {
  const LegalFooter({super.key, required this.serverUrl});
  final String Function() serverUrl;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      alignment: WrapAlignment.center,
      children: [
        for (final p in const [LegalPage.terms, LegalPage.privacy])
          TextButton(onPressed: () => openLegal(context, serverUrl(), p), child: Text(p.label)),
      ],
    );
  }
}
