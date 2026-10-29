import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/legal.dart';
import '../../ui/widgets.dart';
import '../camera/camera_setup_screen.dart';
import '../commentary/commentator_screen.dart';
import '../org/billing_screen.dart';
import '../org/org_screen.dart';
import '../scoring/scorer_screen.dart';
import '../director/control_room_screen.dart';
import '../onboarding/first_show_guide.dart';
import '../tournament/tournament_screen.dart';

/// The screen for a role in a tournament: directors get the tournament hub, everyone
/// else goes straight to their job.
Widget screenFor(Session session, Tournament t, TournamentRole role) => switch (role) {
      TournamentRole.owner || TournamentRole.director => TournamentScreen(session: session, tournament: t),
      TournamentRole.scorer => ScorerScreen(session: session, tournament: t),
      TournamentRole.commentator => CommentatorScreen(session: session, tournament: t),
      TournamentRole.camera || TournamentRole.engine => CameraSetupScreen(session: session, tournament: t),
    };

/// Volunteers who joined with a code: one tournament, one job.
class GuestHome extends StatelessWidget {
  const GuestHome({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final g = session.guest!;
    return screenFor(session, g.tournament, g.role);
  }
}

/// Organisers and staff: their organisations and tournaments.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.session});
  final Session session;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late final ApiClient _api = widget.session.api();
  List<Tournament>? _tournaments;
  ServerInfo _info = const ServerInfo();
  bool _infoLoaded = false;
  OnboardingChecklist? _checklist;
  // The first-show guide opens by itself once, for an organisation with no events.
  final Set<String> _guideShown = {};
  String? _error;

  Session get s => widget.session;

  @override
  void initState() {
    super.initState();
    _load();
    _api.info().then((i) {
      if (!mounted) return;
      setState(() {
        _info = i;
        _infoLoaded = true;
      });
      _maybeGuide();
    }).catchError((Object _) {});
  }

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final list = await _api.tournaments();
      if (mounted) setState(() => _tournaments = list);
      _maybeGuide();
      final org = s.selectedOrg;
      if (org != null && org.canCreateTournaments) {
        final c = await _api.onboarding(org.id).catchError((Object _) => const OnboardingChecklist(live: true));
        if (mounted) setState(() => _checklist = c);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _maybeGuide() {
    final org = s.selectedOrg;
    final list = _tournaments;
    if (!mounted || !_infoLoaded || org == null || list == null || !org.canCreateTournaments) return;
    if (list.any((t) => t.orgId == org.id) || _guideShown.contains(org.id)) return;
    _guideShown.add(org.id);
    WidgetsBinding.instance.addPostFrameCallback((_) => _openGuide(org));
  }

  void _openGuide(OrgMembership org) {
    if (!mounted) return;
    Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => FirstShowGuide(session: s, org: org, info: _info)))
        .then((_) => _load());
  }

  Future<void> _refresh() async {
    await s.refresh();
    await _load();
  }

  Future<void> _newOrg() async {
    final name = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('New organisation'),
        content: TextField(controller: name, autofocus: true, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Club or organisation name')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
        ],
      ),
    );
    final text = name.text.trim();
    name.dispose();
    if (ok != true || text.length < 2 || !mounted) return;
    final org = await guarded(context, () => _api.createOrg(text));
    if (org != null) {
      await s.addOrg(org);
      _maybeGuide();
    }
  }

  Future<void> _newTournament(OrgMembership org) async {
    final name = TextEditingController();
    final venue = TextEditingController();
    DateTime? date;
    // Cloud by default (no laptop). Laptop OBS only under "More options".
    var mode = _info.cloudProduction ? ProductionMode.cloud : ProductionMode.laptop;
    var more = false;
    var type = 'golf';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('New event'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                TextField(
                  controller: name,
                  autofocus: true,
                  textCapitalization: TextCapitalization.words,
                  decoration: const InputDecoration(labelText: 'Event name', hintText: 'Club Championship 2026'),
                ),
                const SizedBox(height: 12),
                Wrap(spacing: 6, runSpacing: 6, children: [
                  for (final (id, label, icon) in eventTypeChoices)
                    ChoiceChip(avatar: Icon(icon, size: 16), label: Text(label), selected: type == id, onSelected: (_) => setLocal(() => type = id)),
                ]),
                const SizedBox(height: 8),
                Text(
                  mode == ProductionMode.cloud
                      ? 'Mixed in the cloud: no laptop needed'
                          '${_info.cloudCostPerHour > 0 ? ' (about ${formatMoney(_info.cloudCostPerHour)} per hour).' : '.'}'
                      : 'Mixed by OBS on a laptop at the venue.',
                  style: Theme.of(c).textTheme.bodySmall,
                ),
                if (!more)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(onPressed: () => setLocal(() => more = true), icon: const Icon(Icons.tune), label: const Text('More options')),
                  ),
                if (more) ...[
                  const SizedBox(height: 12),
                  TextField(controller: venue, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Venue (optional)')),
                  const SizedBox(height: 12),
                  OutlinedButton.icon(
                    icon: const Icon(Icons.event),
                    label: Text(date == null ? 'Date (optional)' : _isoDate(date!)),
                    onPressed: () async {
                      final now = DateTime.now();
                      final d = await showDatePicker(context: c, firstDate: now.subtract(const Duration(days: 30)), lastDate: now.add(const Duration(days: 730)), initialDate: now);
                      if (d != null) setLocal(() => date = d);
                    },
                  ),
                  const SizedBox(height: 8),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Mix on a laptop with OBS instead'),
                    subtitle: Text(_info.cloudProduction ? 'Only for venues with a laptop and good upload.' : 'Cloud production is not enabled on this server.'),
                    value: mode == ProductionMode.laptop,
                    onChanged: _info.cloudProduction ? (v) => setLocal(() => mode = v ? ProductionMode.laptop : ProductionMode.cloud) : null,
                  ),
                ],
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
          ],
        ),
      ),
    );
    final n = name.text.trim();
    final v = venue.text.trim();
    name.dispose();
    venue.dispose();
    if (ok != true || n.isEmpty || !mounted) return;
    final t = await guarded(context, () => _api.createTournament(org.id, name: n, venue: v, startsOn: date == null ? null : _isoDate(date!), mode: mode, eventType: type));
    if (t == null || !mounted) return;
    await _load();
    if (mounted) _open(t.copyWith(role: org.role));
  }

  /// Five steps to the first show, each with the button that does it. Hidden after the first live.
  Widget _checklistCard(BuildContext context, OrgMembership org, Tournament latest) {
    final c = _checklist!;
    final theme = Theme.of(context);
    void control() => Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => ControlRoomScreen(session: s, tournament: latest.copyWith(role: org.role))))
        .then((_) => _load());
    Widget row(bool done, String title, String hint, String action, VoidCallback onTap) => ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          leading: Icon(done ? Icons.check_circle : Icons.radio_button_unchecked, color: done ? Colors.green : null),
          title: Text(title, style: done ? const TextStyle(decoration: TextDecoration.lineThrough) : null),
          subtitle: done ? null : Text(hint),
          trailing: done ? null : TextButton(onPressed: onTap, child: Text(action)),
        );
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Your first show · ${c.count} of 5', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          LinearProgressIndicator(value: c.count / 5),
          row(true, 'Account', '', '', () {}),
          row(c.channel, 'Channel', 'Choose where it goes live', 'Choose', () => _open(latest)),
          row(c.cameras, 'Cameras', 'Share the camera link with the phones', 'Share', () => _open(latest)),
          row(c.test, 'Test', 'Start the show and check the cameras', 'Start', control),
          row(c.live, 'Live', 'Tap Go live in the control room', 'Go live', control),
        ]),
      ),
    );
  }

  static IconData _typeIcon(String id) {
    for (final (tid, _, icon) in eventTypeChoices) {
      if (tid == id) return icon;
    }
    return Icons.live_tv;
  }

  static String _isoDate(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  void _open(Tournament t) {
    final role = t.role ?? s.selectedOrg?.role ?? TournamentRole.camera;
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screenFor(s, t, role))).then((_) => _load());
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final org = s.selectedOrg;
        final list = (_tournaments ?? const <Tournament>[]).where((t) => org == null || t.orgId == org.id).where((t) => !t.archived).toList();
        return Scaffold(
          appBar: AppBar(
            title: s.orgs.length > 1
                ? PopupMenuButton<String>(
                    tooltip: 'Switch organisation',
                    onSelected: s.selectOrg,
                    itemBuilder: (_) => [for (final o in s.orgs) PopupMenuItem(value: o.id, child: Text('${o.name} · ${o.role.label}'))],
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      Flexible(child: Text(org?.name ?? 'Go Live', overflow: TextOverflow.ellipsis)),
                      const Icon(Icons.arrow_drop_down),
                    ]),
                  )
                : Text(org?.name ?? 'Go Live'),
            actions: [
              if (org != null && org.canCreateTournaments)
                IconButton(
                  tooltip: 'Credits',
                  icon: const Icon(Icons.account_balance_wallet_outlined),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                      builder: (_) => BillingScreen(session: s, orgId: org.id, orgName: org.name, isOwner: org.isOwner))),
                ),
              if (org != null && org.isOwner)
                IconButton(
                  tooltip: 'Organisation: staff and YouTube',
                  icon: const Icon(Icons.groups),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => OrgScreen(session: s, org: org))),
                ),
              PopupMenuButton<String>(
                onSelected: (v) {
                  if (v == 'org') _newOrg();
                  if (v == 'refresh') _refresh();
                  for (final p in LegalPage.values) {
                    if (v == p.name) openLegal(context, s.serverUrl, p);
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'refresh', child: Text('Refresh')),
                  const PopupMenuItem(value: 'org', child: Text('New organisation')),
                  const PopupMenuDivider(),
                  for (final p in LegalPage.values) PopupMenuItem(value: p.name, child: Text(p.label)),
                ],
              ),
              SignOutButton(session: s),
            ],
          ),
          floatingActionButton: org != null && org.canCreateTournaments
              ? FloatingActionButton.extended(onPressed: () => _newTournament(org), icon: const Icon(Icons.add), label: const Text('New event'))
              : null,
          body: PageBody(
            onRefresh: _refresh,
            children: [
              Text('Hi ${s.displayName}', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
              if (org == null) ...[
                const InfoBanner(icon: Icons.info_outline, text: 'Name your organisation to start: your club, school, company or event brand. Viewers see it on the watch page.'),
                const SizedBox(height: 12),
                FilledButton.icon(onPressed: _newOrg, icon: const Icon(Icons.add_business), label: const Text('Name your organisation')),
                const SizedBox(height: 8),
                Text('Joining someone else’s team? Ask its owner to add you.', style: Theme.of(context).textTheme.bodySmall),
              ],
              if (org != null && _tournaments == null && _error == null) const LinearProgressIndicator(),
              if (org != null && _checklist != null && !_checklist!.done && list.isNotEmpty) _checklistCard(context, org, list.first),
              if (org != null && _tournaments != null && list.isEmpty)
                org.canCreateTournaments
                    ? Card(
                        child: ListTile(
                          leading: const Icon(Icons.rocket_launch, size: 32),
                          title: const Text('Start your first show'),
                          subtitle: const Text('Three steps: name it, choose where it goes live, add cameras.'),
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () => _openGuide(org),
                        ),
                      )
                    : InfoBanner(icon: Icons.info_outline, text: 'No events in ${org.name} yet.'),
              for (final t in list)
                Card(
                  child: ListTile(
                    leading: Icon(_typeIcon(t.profile.id)),
                    title: Text(t.name),
                    subtitle: Text([t.venue, t.startsOn].whereType<String>().where((x) => x.isNotEmpty).join(' · ')),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      if (t.role != null) Chip(label: Text(t.role!.label), visualDensity: VisualDensity.compact),
                      const Icon(Icons.chevron_right),
                    ]),
                    onTap: () => _open(t),
                  ),
                ),
              const SizedBox(height: 80),
            ],
          ),
        );
      },
    );
  }
}
