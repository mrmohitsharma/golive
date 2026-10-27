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
  String? _error;

  Session get s => widget.session;

  @override
  void initState() {
    super.initState();
    _load();
    _api.info().then((i) {
      if (mounted) setState(() => _info = i);
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
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
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
    if (org != null) await s.addOrg(org);
  }

  Future<void> _newTournament(OrgMembership org) async {
    final name = TextEditingController();
    final venue = TextEditingController();
    DateTime? date;
    var mode = ProductionMode.laptop;
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('New tournament'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                TextField(controller: name, autofocus: true, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name')),
                const SizedBox(height: 12),
                TextField(controller: venue, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Course / venue')),
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
                const SizedBox(height: 16),
                Text('Production', style: Theme.of(c).textTheme.titleSmall),
                const SizedBox(height: 8),
                SegmentedButton<ProductionMode>(
                  segments: [
                    const ButtonSegment(value: ProductionMode.laptop, label: Text('Laptop OBS'), icon: Icon(Icons.laptop)),
                    ButtonSegment(value: ProductionMode.cloud, label: const Text('Cloud'), icon: const Icon(Icons.cloud), enabled: _info.cloudProduction),
                  ],
                  selected: {mode},
                  onSelectionChanged: (m) => setLocal(() => mode = m.first),
                ),
                const SizedBox(height: 8),
                Text(
                  mode == ProductionMode.laptop
                      ? 'OBS runs on a laptop at the course. Best when the clubhouse has good upload.'
                      : 'OBS runs on our server, started for the event and stopped after. No laptop needed'
                          '${_info.cloudCostPerHour > 0 ? ' (about ${formatMoney(_info.cloudCostPerHour)} per hour).' : '.'}',
                  style: Theme.of(c).textTheme.bodySmall,
                ),
                if (!_info.cloudProduction) Text('Cloud production is not enabled on this server.', style: Theme.of(c).textTheme.bodySmall),
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
    final t = await guarded(context, () => _api.createTournament(org.id, name: n, venue: v, startsOn: date == null ? null : _isoDate(date!), mode: mode));
    if (t == null || !mounted) return;
    await _load();
    if (mounted) _open(t.copyWith(role: org.role));
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
              ? FloatingActionButton.extended(onPressed: () => _newTournament(org), icon: const Icon(Icons.add), label: const Text('New tournament'))
              : null,
          body: PageBody(
            onRefresh: _refresh,
            children: [
              Text('Hi ${s.displayName}', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
              if (org == null) ...[
                const InfoBanner(icon: Icons.info_outline, text: 'You are not part of an organisation yet. Create one, or ask your club owner to add you.'),
                const SizedBox(height: 12),
                FilledButton.icon(onPressed: _newOrg, icon: const Icon(Icons.add_business), label: const Text('Create organisation')),
              ],
              if (org != null && _tournaments == null && _error == null) const LinearProgressIndicator(),
              if (org != null && _tournaments != null && list.isEmpty)
                InfoBanner(
                  icon: Icons.info_outline,
                  text: org.canCreateTournaments ? 'No tournaments yet. Tap “New tournament” to start.' : 'No tournaments in ${org.name} yet.',
                ),
              for (final t in list)
                Card(
                  child: ListTile(
                    leading: Icon(t.mode == ProductionMode.cloud ? Icons.cloud : Icons.golf_course),
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
