import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

/// Owner-only: staff accounts and the club's YouTube channel.
class OrgScreen extends StatefulWidget {
  const OrgScreen({super.key, required this.session, required this.org});
  final Session session;
  final OrgMembership org;

  @override
  State<OrgScreen> createState() => _OrgScreenState();
}

class _OrgScreenState extends State<OrgScreen> with WidgetsBindingObserver {
  late final ApiClient _api = widget.session.api();
  List<OrgMember>? _members;
  OrgYoutube? _yt;
  OrgFacebook? _fb;
  String? _error;
  bool _waitingForGoogle = false;

  String get _orgId => widget.org.id;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _api.close();
    super.dispose();
  }

  /// Coming back from the browser after Google consent: show the new channel.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _waitingForGoogle) {
      _waitingForGoogle = false;
      _load();
    }
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([_api.members(_orgId), _api.orgYoutube(_orgId), _api.orgFacebook(_orgId)]);
      if (!mounted) return;
      setState(() {
        _members = results[0] as List<OrgMember>;
        _yt = results[1] as OrgYoutube;
        _fb = results[2] as OrgFacebook;
        _error = null;
      });
      final fb = _fb!;
      if (fb.connected && fb.pageId == null && fb.pages.length > 1 && mounted) await _choosePage(fb);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _connectYoutube() async {
    final url = await guarded(context, () => _api.youtubeConnectUrl(_orgId));
    if (url == null) return;
    _waitingForGoogle = true;
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (!ok && mounted) toast(context, 'Could not open the browser.', error: true);
  }

  Future<void> _connectFacebook() async {
    final url = await guarded(context, () => _api.facebookConnectUrl(_orgId));
    if (url == null) return;
    _waitingForGoogle = true;
    final ok = await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    if (!ok && mounted) toast(context, 'Could not open the browser.', error: true);
  }

  Future<void> _choosePage(OrgFacebook fb) async {
    final id = await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(
        title: const Text('Which Page should go live?'),
        children: [
          for (final p in fb.pages)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(c, p.id),
              child: Row(children: [
                Icon(p.id == fb.pageId ? Icons.radio_button_checked : Icons.radio_button_unchecked, size: 20),
                const SizedBox(width: 12),
                Expanded(child: Text(p.name, style: const TextStyle(fontSize: 16))),
              ]),
            ),
        ],
      ),
    );
    if (id == null || !mounted) return;
    final r = await guarded(context, () => _api.selectFacebookPage(_orgId, id));
    if (r != null && mounted) setState(() => _fb = r);
  }

  Future<void> _disconnectFacebook() async {
    final ok = await confirm(context,
        title: 'Disconnect Facebook?',
        message: 'Tournaments stop going live on the Page until you connect again.',
        action: 'Disconnect',
        destructive: true);
    if (!ok || !mounted) return;
    await guarded(context, () => _api.disconnectFacebook(_orgId));
    await _load();
  }

  Future<void> _disconnectYoutube() async {
    final ok = await confirm(context,
        title: 'Disconnect YouTube?',
        message: 'New broadcasts will not be created automatically until you connect again. Live streams keep running.',
        action: 'Disconnect',
        destructive: true);
    if (!ok || !mounted) return;
    await guarded(context, () => _api.disconnectYoutube(_orgId));
    await _load();
  }

  Future<void> _addMember() async {
    final email = TextEditingController();
    final name = TextEditingController();
    final password = TextEditingController();
    var role = TournamentRole.director;
    String? error;
    bool? created;
    await showDialog<void>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('Add staff'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                TextField(controller: email, keyboardType: TextInputType.emailAddress, autocorrect: false, decoration: const InputDecoration(labelText: 'Email')),
                const SizedBox(height: 12),
                DropdownButtonFormField<TournamentRole>(
                  initialValue: role,
                  decoration: const InputDecoration(labelText: 'Role'),
                  items: [for (final r in orgRoles) DropdownMenuItem(value: r, child: Text(r.label))],
                  onChanged: (v) => setLocal(() => role = v ?? role),
                ),
                const SizedBox(height: 12),
                Text('New to CoGolfer Live? Also give their name and a first password to share with them:', style: Theme.of(c).textTheme.bodySmall),
                const SizedBox(height: 8),
                TextField(controller: name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Name (new accounts)')),
                const SizedBox(height: 12),
                TextField(controller: password, decoration: const InputDecoration(labelText: 'First password (new accounts, 8+)')),
                const SizedBox(height: 8),
                Text('Volunteers (camera, scorer, commentator) do not need accounts: give them a join code from the tournament.',
                    style: Theme.of(c).textTheme.bodySmall),
                if (error != null) ...[const SizedBox(height: 12), InfoBanner(icon: Icons.error_outline, text: error!, error: true)],
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            FilledButton(
              onPressed: () async {
                try {
                  created = await _api.addMember(_orgId, email: email.text.trim(), role: role, name: name.text.trim(), password: password.text);
                  if (c.mounted) Navigator.pop(c);
                } on ApiException catch (e) {
                  setLocal(() => error = e.message);
                }
              },
              child: const Text('Add'),
            ),
          ],
        ),
      ),
    );
    final newEmail = email.text.trim();
    final newPassword = password.text;
    email.dispose();
    name.dispose();
    password.dispose();
    if (created == null || !mounted) return;
    await _load();
    if (created == true && mounted) {
      await showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(
          title: const Text('Account created'),
          content: SelectableText('Send these to them securely:\n\nServer: ${widget.session.serverUrl}\nEmail: $newEmail\nPassword: $newPassword'),
          actions: [
            TextButton(
              onPressed: () => copyText(c, 'Server: ${widget.session.serverUrl}\nEmail: $newEmail\nPassword: $newPassword', 'Sign-in details'),
              child: const Text('Copy'),
            ),
            FilledButton(onPressed: () => Navigator.pop(c), child: const Text('Done')),
          ],
        ),
      );
    }
  }

  Future<void> _memberActions(OrgMember m) async {
    final me = widget.session.user?.id == m.userId;
    final choice = await showModalBottomSheet<Object>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text(m.name), subtitle: Text(m.email)),
          RadioGroup<TournamentRole>(
            groupValue: m.role,
            onChanged: (v) => Navigator.pop(c, v),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              for (final r in orgRoles) RadioListTile<TournamentRole>(value: r, title: Text(r.label)),
            ]),
          ),
          if (!me)
            ListTile(
              leading: const Icon(Icons.person_remove, color: Broadcast.onAir),
              title: const Text('Remove from organisation'),
              onTap: () => Navigator.pop(c, 'remove'),
            ),
        ]),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'remove') {
      final ok = await confirm(context, title: 'Remove ${m.name}?', message: 'They lose access to all tournaments of ${widget.org.name}.', action: 'Remove', destructive: true);
      if (!ok || !mounted) return;
      await guarded(context, () => _api.removeMember(_orgId, m.userId));
    } else if (choice is TournamentRole && choice != m.role) {
      await guarded(context, () => _api.setMemberRole(_orgId, m.userId, choice));
    }
    await _load();
  }

  List<Widget> _facebookSection(BuildContext context) {
    final fb = _fb;
    final small = Theme.of(context).textTheme.bodySmall;
    if (fb == null) return [const LinearProgressIndicator()];
    if (!fb.enabled) {
      return const [InfoBanner(icon: Icons.info_outline, text: 'Facebook live is not set up on this server (Meta app ID and secret).')];
    }
    if (!fb.connected) {
      return [
        const Text('Connect the club’s Facebook Page once. When you go live, the broadcast also goes live on the Page.'),
        const SizedBox(height: 12),
        Align(alignment: Alignment.centerLeft, child: FilledButton.icon(onPressed: _connectFacebook, icon: const Icon(Icons.link), label: const Text('Connect Facebook'))),
        const SizedBox(height: 8),
        Text('Sign in as an admin of the Page. Facebook requires the Page to be at least 60 days old with 100+ followers.', style: small),
      ];
    }
    return [
      ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(fb.pageId == null ? Icons.warning_amber : Icons.check_circle, color: fb.pageId == null ? Broadcast.warning : Broadcast.preview),
        title: Text(fb.pageName ?? 'Choose a Page'),
        subtitle: Text('Connected as ${fb.userName ?? ''}'),
        trailing: fb.pages.length > 1 ? TextButton(onPressed: () => _choosePage(fb), child: const Text('Change')) : null,
      ),
      Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _disconnectFacebook, child: const Text('Disconnect'))),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final yt = _yt;
    final members = _members;
    return Scaffold(
      appBar: AppBar(title: Text(widget.org.name)),
      floatingActionButton: FloatingActionButton.extended(onPressed: _addMember, icon: const Icon(Icons.person_add), label: const Text('Add staff')),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
          SectionCard(
            icon: Icons.smart_display,
            title: 'YouTube',
            children: [
              if (yt == null) const LinearProgressIndicator(),
              if (yt != null && !yt.enabled)
                const InfoBanner(
                  icon: Icons.info_outline,
                  text: 'YouTube connection is not set up on this server. Directors can still stream with a stream key in OBS.',
                ),
              if (yt != null && yt.enabled && !yt.connected) ...[
                const Text('Connect your club’s YouTube channel once. Each tournament then creates its own live broadcast automatically: '
                    'no stream keys to copy.'),
                const SizedBox(height: 12),
                FilledButton.icon(onPressed: _connectYoutube, icon: const Icon(Icons.link), label: const Text('Connect YouTube')),
                const SizedBox(height: 8),
                Text('The channel must have live streaming enabled (YouTube Studio > Go live; first time takes up to 24 hours).',
                    style: Theme.of(context).textTheme.bodySmall),
              ],
              if (yt != null && yt.connected) ...[
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.check_circle, color: Broadcast.preview),
                  title: Text(yt.channelTitle ?? 'Connected'),
                  subtitle: const Text('Broadcasts are created from each tournament.'),
                ),
                Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: _disconnectYoutube, child: const Text('Disconnect'))),
              ],
            ],
          ),
          SectionCard(
            icon: Icons.facebook,
            title: 'Facebook Page',
            children: _facebookSection(context),
          ),
          SectionCard(
            icon: Icons.groups,
            title: 'Staff',
            children: [
              if (members == null && _error == null) const LinearProgressIndicator(),
              for (final m in members ?? const <OrgMember>[])
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: CircleAvatar(child: Text(m.name.isEmpty ? '?' : m.name[0].toUpperCase())),
                  title: Text(m.name),
                  subtitle: Text(m.email),
                  trailing: Chip(label: Text(m.role.label), visualDensity: VisualDensity.compact),
                  onTap: () => _memberActions(m),
                ),
            ],
          ),
          const SizedBox(height: 80),
        ],
      ),
    );
  }
}
