import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// The club's credit wallet: balance, what is free, buy credits (Cashfree), history.
/// Owners also keep the billing contact (mobile number for receipts, GSTIN).
class BillingScreen extends StatefulWidget {
  const BillingScreen({super.key, required this.session, required this.orgId, required this.orgName, this.isOwner = false});
  final Session session;
  final String orgId;
  final String orgName;
  final bool isOwner;

  @override
  State<BillingScreen> createState() => _BillingScreenState();
}

class _BillingScreenState extends State<BillingScreen> with WidgetsBindingObserver {
  late final ApiClient _api = widget.session.api();
  OrgBilling? _b;
  String? _error;

  /// A checkout opened in the browser that we are waiting on.
  PaymentInfo? _waiting;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _api.close();
    super.dispose();
  }

  /// Back from the Cashfree page: check the payment at once.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _waiting != null) _checkPayment();
  }

  Future<void> _load() async {
    try {
      final b = await _api.orgBilling(widget.orgId);
      if (!mounted) return;
      setState(() {
        _b = b;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _buy(CreditPack pack) async {
    final b = _b!;
    final ok = await confirm(
      context,
      title: 'Buy ${formatAmount(pack.credits)} credits?',
      message: 'Pay ₹${formatAmount(pack.priceInr)} by UPI, card or net banking on Cashfree’s secure page. Credits are added as soon as the payment goes through.',
      action: 'Continue to payment',
    );
    if (!ok || !mounted) return;
    String? phone = b.details?.phone;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final (payment, url) = await _api.checkout(widget.orgId, pack.id, phone: phone);
        _waiting = payment;
        _poll?.cancel();
        _poll = Timer.periodic(const Duration(seconds: 4), (_) => _checkPayment());
        final opened = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
        if (!opened && mounted) toast(context, 'Could not open the browser.', error: true);
        if (mounted) setState(() {});
        return;
      } on ApiException catch (e) {
        if (e.code == 'phone_required' && attempt == 0) {
          phone = await _askPhone();
          if (phone == null) return;
          continue;
        }
        if (mounted) toast(context, e.message, error: true);
        return;
      }
    }
  }

  Future<String?> _askPhone() async {
    final c = TextEditingController();
    final r = await showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Mobile number'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          const Text('Cashfree sends the payment receipt to this number.'),
          const SizedBox(height: 12),
          TextField(controller: c, keyboardType: TextInputType.phone, autofocus: true, decoration: const InputDecoration(labelText: 'Mobile', prefixText: '+91 ')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, c.text.trim()), child: const Text('Continue')),
        ],
      ),
    );
    c.dispose();
    return (r == null || r.isEmpty) ? null : r;
  }

  Future<void> _checkPayment() async {
    final w = _waiting;
    if (w == null) return;
    try {
      final (p, balance) = await _api.payment(w.id);
      if (!mounted) return;
      if (p.status == PaymentStatus.paid) {
        _poll?.cancel();
        _waiting = null;
        toast(context, '${formatAmount(p.credits)} credits added. Balance ${formatAmount(balance)}.');
        await _load();
      } else if (p.status == PaymentStatus.expired || p.status == PaymentStatus.failed) {
        _poll?.cancel();
        setState(() => _waiting = null);
        toast(context, 'The payment was not completed.', error: true);
      }
    } on ApiException {
      // keep waiting; the network may be flaky at the course
    }
  }

  void _stopWaiting() {
    _poll?.cancel();
    setState(() => _waiting = null);
  }

  Future<void> _editDetails() async {
    final d = _b?.details ?? const BillingDetails();
    final name = TextEditingController(text: d.name ?? widget.orgName);
    final phone = TextEditingController(text: d.phone ?? '');
    final email = TextEditingController(text: d.email ?? '');
    final gstin = TextEditingController(text: d.gstin ?? '');
    String? error;
    await showDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('Billing details'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                TextField(controller: name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Billing name')),
                const SizedBox(height: 12),
                TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile (payment receipts)', prefixText: '+91 ')),
                const SizedBox(height: 12),
                TextField(controller: email, keyboardType: TextInputType.emailAddress, autocorrect: false, decoration: const InputDecoration(labelText: 'Billing email')),
                const SizedBox(height: 12),
                TextField(controller: gstin, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'GSTIN (optional)')),
                if (error != null) ...[const SizedBox(height: 12), InfoBanner(icon: Icons.error_outline, text: error!, error: true)],
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  await _api.saveBillingDetails(widget.orgId, name: name.text, phone: phone.text, email: email.text, gstin: gstin.text);
                  if (c.mounted) Navigator.pop(c);
                } on ApiException catch (e) {
                  setLocal(() => error = e.message);
                }
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    );
    for (final x in [name, phone, email, gstin]) {
      x.dispose();
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final b = _b;
    final small = Theme.of(context).textTheme.bodySmall;
    return Scaffold(
      appBar: AppBar(title: const Text('Credits')),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          if (b == null && _error == null) const LinearProgressIndicator(),
          if (b != null && !b.enabled)
            const InfoBanner(icon: Icons.all_inclusive, text: 'This server has no camera or live-time limits. Nothing to pay.'),
          if (b != null && b.enabled) ...[
            if (b.suspended) ...[
              InfoBanner(
                icon: Icons.block,
                error: true,
                text: 'Your club is suspended by CoGolfers${b.suspendedReason != null ? ': ${b.suspendedReason}' : ''}. You cannot go live until it is lifted. Contact CoGolfers support.',
              ),
              const SizedBox(height: 12),
            ],
            _BalanceCard(balance: b.balance, pricing: b.pricing, orgName: widget.orgName),
            if (_waiting != null) ...[
              const SizedBox(height: 12),
              Card(
                child: ListTile(
                  leading: const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5)),
                  title: Text('Waiting for your payment of ₹${formatAmount(_waiting!.amountInr)}'),
                  subtitle: const Text('Finish paying in the browser. Credits appear here automatically.'),
                  trailing: TextButton(onPressed: _stopWaiting, child: const Text('Hide')),
                ),
              ),
            ],
            const SizedBox(height: 12),
            SectionCard(
              icon: Icons.add_card,
              title: 'Buy credits',
              children: [
                if (!b.paymentsEnabled)
                  const InfoBanner(icon: Icons.info_outline, text: 'Online payment is not switched on yet. Contact CoGolfers to add credits to your club.')
                else ...[
                  for (final p in b.packs)
                    Card(
                      margin: const EdgeInsets.only(bottom: 8),
                      color: Theme.of(context).colorScheme.surfaceContainerHigh,
                      child: ListTile(
                        title: Text('${formatAmount(p.credits)} credits', style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Text([p.label, if (p.bonusPercent > 0) '${p.bonusPercent}% extra'].join(' · ')),
                        trailing: FilledButton(
                          onPressed: b.suspended || _waiting != null ? null : () => _buy(p),
                          child: Text('₹${formatAmount(p.priceInr)}'),
                        ),
                      ),
                    ),
                  Text('Secure payment by Cashfree: UPI, cards, net banking. Credits do not expire.', style: small),
                ],
              ],
            ),
            if (widget.isOwner)
              SectionCard(
                icon: Icons.receipt_long,
                title: 'Billing details',
                trailing: TextButton(onPressed: _editDetails, child: const Text('Edit')),
                children: [
                  Text(
                    [
                      b.details?.name ?? widget.orgName,
                      if (b.details?.phone != null) 'Mobile ${b.details!.phone}',
                      if (b.details?.email != null) b.details!.email!,
                      if (b.details?.gstin != null) 'GSTIN ${b.details!.gstin}',
                    ].join('\n'),
                  ),
                ],
              ),
            SectionCard(
              icon: Icons.history,
              title: 'History',
              children: [
                if (b.transactions.isEmpty) const Text('No credit activity yet.'),
                for (final t in b.transactions)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    dense: true,
                    leading: Icon(_icon(t.kind)),
                    title: Text(t.title),
                    subtitle: Text([if (t.tournamentName != null) t.tournamentName!, _date(t.at)].join(' · ')),
                    trailing: Text(
                      '${t.credits > 0 ? '+' : ''}${formatAmount(t.credits)}',
                      style: TextStyle(fontWeight: FontWeight.w700, color: t.credits >= 0 ? Broadcast.preview : null),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  static IconData _icon(WalletKind k) => switch (k) {
        WalletKind.purchase => Icons.add_card,
        WalletKind.cameras => Icons.videocam,
        WalletKind.minutes => Icons.timer,
        WalletKind.admin => Icons.support_agent,
        WalletKind.refund => Icons.undo,
      };

  static String _date(DateTime d) {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${d.day} ${m[d.month - 1]}, ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}

class _BalanceCard extends StatelessWidget {
  const _BalanceCard({required this.balance, required this.pricing, required this.orgName});
  final double balance;
  final BillingPricing pricing;
  final String orgName;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final perMinute = pricing.minutePrice;
    return Card(
      color: Broadcast.course,
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(orgName.toUpperCase(), style: t.labelSmall?.copyWith(color: Colors.white70, letterSpacing: 1.2)),
          const SizedBox(height: 4),
          Text('${formatAmount(balance)} credits', style: t.headlineMedium?.copyWith(color: Colors.white, fontWeight: FontWeight.w800)),
          if (perMinute > 0)
            Text('About ${(balance / perMinute).floor()} paid live minutes', style: t.bodyMedium?.copyWith(color: Colors.white70)),
          const Divider(height: 24, color: Colors.white24),
          Text('Free in every tournament: ${pricing.freeCameras} cameras and ${pricing.freeMinutes} live minutes.', style: t.bodyMedium?.copyWith(color: Colors.white)),
          const SizedBox(height: 4),
          Text(
            [
              'Extra camera: ${formatAmount(pricing.cameraPrice)} credits per tournament',
              perMinute > 0 ? 'Live time after that: ${formatAmount(perMinute)} credits per minute' : 'Live time after that: no charge',
            ].join('\n'),
            style: t.bodySmall?.copyWith(color: Colors.white70),
          ),
        ]),
      ),
    );
  }
}
