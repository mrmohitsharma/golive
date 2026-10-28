import 'dart:async';

import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';
import '../camera/camera_setup_screen.dart';
import '../clips/clips_screen.dart';
import '../commentary/commentator_screen.dart';
import '../director/control_room_screen.dart';
import '../org/billing_screen.dart';
import '../scoring/scorer_screen.dart';
import 'course_screen.dart';
import 'invite_card.dart';
import 'join_codes_screen.dart';

/// Everything an organiser/director sets up for one tournament, and the way into the
/// control room and the other roles.
class TournamentScreen extends StatefulWidget {
  const TournamentScreen({super.key, required this.session, required this.tournament});
  final Session session;
  final Tournament tournament;

  @override
  State<TournamentScreen> createState() => _TournamentScreenState();
}

class _TournamentScreenState extends State<TournamentScreen> {
  late final ApiClient _api = widget.session.api();
  late Tournament _t = widget.tournament;
  ProductionState _production = const ProductionState();
  YoutubeState _youtube = const YoutubeState();
  EngineState _engine = const EngineState();
  OutputsState _outputs = const OutputsState();
  TournamentBilling _billing = const TournamentBilling();
  List<Invite> _invites = const [];
  bool _loaded = false;
  bool _busy = false;
  String? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _load();
    _loadInvites();
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _load(quiet: true));
  }

  @override
  void dispose() {
    _poll?.cancel();
    _api.close();
    super.dispose();
  }

  Future<void> _load({bool quiet = false}) async {
    try {
      final s = await _api.tournamentState(_t.id);
      if (!mounted) return;
      setState(() {
        final t = s['tournament'] as Map<String, dynamic>?;
        if (t != null) {
          _t = Tournament.fromJson({
            ...t,
            'orgId': _t.orgId,
            'orgName': _t.orgName,
            'role': (s['role'] as String?) ?? _t.role?.name,
          });
        }
        _production = ProductionState.fromJson(s['production'] as Map<String, dynamic>?);
        _youtube = YoutubeState.fromJson(s['youtube'] as Map<String, dynamic>?);
        _engine = EngineState.fromJson(s['engine'] as Map<String, dynamic>?);
        _outputs = OutputsState.fromJson(s['outputs'] as Map<String, dynamic>?);
        _billing = TournamentBilling.fromJson(s['billing'] as Map<String, dynamic>?);
        _loaded = true;
        _error = null;
      });
    } on ApiException catch (e) {
      if (mounted && !quiet) setState(() => _error = e.message);
    }
  }

  Future<void> _loadInvites() async {
    if (!(_t.role?.canDirect ?? true)) return;
    try {
      final list = await _api.invites(_t.id);
      if (mounted) setState(() => _invites = list);
    } on ApiException {
      // Not allowed or offline: the card just stays hidden.
    }
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    await guarded(context, action);
    if (mounted) setState(() => _busy = false);
    await _load();
  }

  void _push(Widget page) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page)).then((_) {
        _load(quiet: true);
        _loadInvites();
      });

  // ---------------------------------------------------------------- plan & credits
  void _openCredits() => _push(BillingScreen(
        session: widget.session,
        orgId: _t.orgId ?? '',
        orgName: _t.orgName ?? widget.session.selectedOrg?.name ?? 'Club',
        isOwner: _t.role == TournamentRole.owner,
      ));

  Future<void> _buyCameras() async {
    final b = _billing;
    var count = 1;
    final choice = await showDialog<String>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) {
          final cost = b.pricing.cameraPrice * count;
          final enough = cost <= b.balance;
          return AlertDialog(
            title: const Text('Extra cameras'),
            content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text('For this tournament only. ${formatAmount(b.pricing.cameraPrice)} credits each.'),
              const SizedBox(height: 16),
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                IconButton.filledTonal(onPressed: count > 1 ? () => setLocal(() => count--) : null, icon: const Icon(Icons.remove)),
                Padding(padding: const EdgeInsets.symmetric(horizontal: 20), child: Text('$count', style: Theme.of(c).textTheme.headlineMedium)),
                IconButton.filledTonal(onPressed: count < 20 ? () => setLocal(() => count++) : null, icon: const Icon(Icons.add)),
              ]),
              const SizedBox(height: 12),
              Text('${formatAmount(cost)} credits · balance ${formatAmount(b.balance)}', textAlign: TextAlign.center),
              if (!enough) ...[
                const SizedBox(height: 12),
                const InfoBanner(icon: Icons.account_balance_wallet_outlined, text: 'Not enough credits. Buy credits first.', error: true),
              ],
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
              if (!enough)
                FilledButton(onPressed: () => Navigator.pop(c, 'credits'), child: const Text('Buy credits'))
              else
                FilledButton(onPressed: () => Navigator.pop(c, 'buy'), child: Text('Buy $count')),
            ],
          );
        },
      ),
    );
    if (!mounted) return;
    if (choice == 'credits') {
      _openCredits();
      return;
    }
    if (choice != 'buy') return;
    await _run(() async => _billing = await _api.buyCameras(_t.id, count));
    if (mounted) toast(context, '$count extra camera${count > 1 ? 's' : ''} added');
  }

  List<Widget> _planSection(BuildContext context) {
    final b = _billing;
    final small = Theme.of(context).textTheme.bodySmall;
    final freeMin = (b.freeSecondsLeft / 60).ceil();
    final rem = b.remainingMinutes;
    return [
      if (b.suspended) ...[
        InfoBanner(icon: Icons.block, error: true, text: b.reason ?? 'Your club is suspended by CoGolfers.'),
        const SizedBox(height: 12),
      ],
      _PlanRow(
        icon: Icons.videocam,
        title: 'Cameras: ${b.camerasUsed} of ${b.cameraLimit} used',
        subtitle: '${b.camerasFree} free${b.camerasExtra > 0 ? ' + ${b.camerasExtra} bought' : ''}. Extra camera ${formatAmount(b.pricing.cameraPrice)} credits.',
        action: TextButton(onPressed: b.suspended || _busy ? null : _buyCameras, child: const Text('Add camera')),
      ),
      _PlanRow(
        icon: Icons.cell_tower,
        title: 'Destinations: ${b.destinationsUsed} of ${b.destinationLimit} included',
        subtitle: '${b.destinationsFree} free${b.destinationsExtra > 0 ? ' + ${b.destinationsExtra} bought' : ''}. '
            'Each YouTube channel, Facebook or Instagram account counts as one. Extra destination ${formatAmount(b.destinationPrice)} credits.',
        warn: b.destinationsUsed > b.destinationLimit,
      ),
      _PlanRow(
        icon: Icons.timer_outlined,
        title: rem == null ? 'Live time: no limit' : (b.graceActive ? 'Credits finished: grace period' : 'Live time left: about $rem min'),
        subtitle: [
          freeMin > 0 ? '$freeMin of ${b.pricing.freeMinutes} free minutes left' : 'Free ${b.pricing.freeMinutes} minutes used',
          if (b.pricing.minutePrice > 0) 'then ${formatAmount(b.pricing.minutePrice)} credits per minute',
        ].join(', '),
        warn: b.low || b.graceActive,
      ),
      _PlanRow(
        icon: Icons.account_balance_wallet_outlined,
        title: 'Club balance: ${formatAmount(b.balance)} credits',
        subtitle: 'Shared by all tournaments of the club',
        action: TextButton(onPressed: _openCredits, child: const Text('Buy credits')),
      ),
      if (!b.canGoLive && !b.suspended && b.reason != null) ...[
        const SizedBox(height: 4),
        InfoBanner(icon: Icons.warning_amber, text: b.reason!, error: true),
      ],
      const SizedBox(height: 4),
      Text('When credits run low the director is warned at 10 and 2 minutes left. After that the stream keeps going for ${b.pricing.graceMinutes} minutes, then ends.',
          style: small),
    ];
  }

  // ---------------------------------------------------------------- production
  Future<void> _setMode(ProductionMode m) => _run(() async {
        _t = await _api.updateTournament(_t.id, mode: m);
      });

  Future<void> _startCloud() async {
    final ok = await confirm(
      context,
      title: 'Start the cloud engine?',
      message: 'OBS starts on the server for this tournament (about a minute). '
          '${_production.costPerHour > 0 ? 'It costs about ${formatMoney(_production.costPerHour)} per hour while running. ' : ''}'
          '${_production.autoStopAfterIdleMin > 0 ? 'It stops by itself after ${_production.autoStopAfterIdleMin} minutes with no stream.' : ''}',
      action: 'Start',
    );
    if (ok) await _run(() async => _production = await _api.startCloudEngine(_t.id));
  }

  Future<void> _stopCloud() async {
    final live = _engine.streaming.active;
    final ok = await confirm(
      context,
      title: 'Stop the cloud engine?',
      message: live ? 'The YouTube stream is LIVE and will end for viewers.' : 'You can start it again later.',
      action: live ? 'End stream and stop' : 'Stop',
      destructive: live,
    );
    if (ok) await _run(() async => _production = await _api.stopCloudEngine(_t.id, force: live));
  }

  Future<void> _engineSetup() async {
    final setup = await guarded(context, () => _api.engineSetup(_t.id));
    if (setup == null || !mounted) return;
    await showDialog<void>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Laptop engine setup'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text('On the production laptop: install OBS Studio and the CoGolfer agent, enable OBS WebSocket '
                  '(Tools > WebSocket Server Settings), then put this in the agent’s .env file and add the OBS password:'),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Colors.black38, borderRadius: BorderRadius.circular(8)),
                child: SelectableText(setup.envFile, style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5)),
              ),
              const SizedBox(height: 8),
              const Text('Keep the engine key private: it controls this tournament’s broadcast.', style: TextStyle(fontSize: 12)),
            ]),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              final ok = await confirm(c, title: 'Rotate engine key?', message: 'The laptop agent disconnects until you update its .env.', action: 'Rotate');
              if (!ok || !c.mounted) return;
              final key = await guarded(c, () => _api.rotateEngineKey(_t.id));
              if (key != null && c.mounted) {
                Navigator.pop(c);
                await _engineSetup();
              }
            },
            child: const Text('Rotate key'),
          ),
          TextButton(onPressed: () => SharePlus.instance.share(ShareParams(text: setup.envFile, subject: '${_t.name} engine .env')), child: const Text('Share')),
          TextButton(onPressed: () => copyText(c, setup.envFile, '.env'), child: const Text('Copy')),
          FilledButton(onPressed: () => Navigator.pop(c), child: const Text('Done')),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------- YouTube
  Future<void> _createBroadcast() async {
    final onGolive = _youtube.source == YoutubeSource.golive;
    final org = _t.orgName ?? widget.session.selectedOrg?.name;
    final title = TextEditingController(text: onGolive && org != null ? '${_t.name} by $org' : _t.title);
    var privacy = 'unlisted';
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('Create YouTube broadcast'),
          content: SizedBox(
            width: 420,
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(controller: title, maxLength: 100, decoration: const InputDecoration(labelText: 'Title')),
              const SizedBox(height: 8),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'public', label: Text('Public')),
                  ButtonSegment(value: 'unlisted', label: Text('Unlisted')),
                  ButtonSegment(value: 'private', label: Text('Private')),
                ],
                selected: {privacy},
                onSelectionChanged: (s) => setLocal(() => privacy = s.first),
              ),
              const SizedBox(height: 8),
              Text('The broadcast goes live when the director taps “Go live”, and ends when they end the stream.',
                  style: Theme.of(c).textTheme.bodySmall),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Create')),
          ],
        ),
      ),
    );
    final text = title.text.trim();
    title.dispose();
    if (ok == true) await _run(() async => _youtube = await _api.createBroadcast(_t.id, title: text, privacy: privacy));
  }

  Future<void> _forgetBroadcast() async {
    final ok = await confirm(context,
        title: 'Replace the broadcast?',
        message: 'The app forgets this YouTube broadcast so you can create a new one. The old one stays on YouTube.',
        action: 'Forget it');
    if (ok) await _run(() => _api.forgetBroadcast(_t.id));
  }

  // ---------------------------------------------------------------- platforms
  Future<void> _setPlatform(StreamPlatform p, bool on) async {
    final r = await _withRoom(() => _api.setOutputs(_t.id, {p.name: {'enabled': on}}));
    if (r != null && mounted) setState(() => _outputs = r);
    if (r != null) await _load(quiet: true);
  }

  /// Runs a change that may add a destination. If the event has no room left, offers to buy
  /// one more destination for this event and then tries the change again.
  Future<T?> _withRoom<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      if (!mounted) return null;
      if (e.code != 'destination_limit') {
        toast(context, e.message, error: true);
        return null;
      }
      if (!await _buyDestination(e.message) || !mounted) return null;
      return guarded(context, call);
    }
  }

  Future<bool> _buyDestination(String why) async {
    final b = _billing;
    final price = b.destinationPrice;
    final enough = price <= b.balance;
    final choice = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Add a destination'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(why),
          const SizedBox(height: 12),
          Text('One more destination for this event costs ${formatAmount(price)} credits. Club balance: ${formatAmount(b.balance)} credits.'),
          if (!enough) ...[
            const SizedBox(height: 12),
            const InfoBanner(icon: Icons.account_balance_wallet_outlined, text: 'Not enough credits. Buy credits first.', error: true),
          ],
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
          if (enough)
            FilledButton(onPressed: () => Navigator.pop(c, 'buy'), child: Text('Add for ${formatAmount(price)} credits'))
          else
            FilledButton(onPressed: () => Navigator.pop(c, 'credits'), child: const Text('Buy credits')),
        ],
      ),
    );
    if (!mounted) return false;
    if (choice == 'credits') {
      _openCredits();
      return false;
    }
    if (choice != 'buy') return false;
    final r = await guarded(context, () => _api.buyDestinations(_t.id, 1));
    if (r == null || !mounted) return false;
    setState(() => _billing = r);
    return true;
  }

  // ---------------------------------------------------------------- extra destinations
  void _applyDestinations((OutputsState, TournamentBilling)? r) {
    if (r == null || !mounted) return;
    setState(() {
      _outputs = r.$1;
      _billing = r.$2;
    });
  }

  Future<void> _addDestination() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const ListTile(title: Text('Add a destination'), subtitle: Text('The same show also goes here when you go live.')),
          ListTile(
            leading: const Icon(Icons.smart_display),
            title: const Text('Another YouTube channel'),
            subtitle: const Text('Connected with Google sign-in; the broadcast is made for you'),
            onTap: () => Navigator.pop(c, 'channel'),
          ),
          ListTile(
            leading: const Icon(Icons.key),
            title: const Text('YouTube with a stream key'),
            subtitle: const Text('Any channel: copy the key from YouTube Studio'),
            onTap: () => Navigator.pop(c, 'youtube'),
          ),
          ListTile(
            leading: const Icon(Icons.facebook),
            title: const Text('Facebook with a stream key'),
            subtitle: const Text('A profile, Page or group: copy the key from Live Producer'),
            onTap: () => Navigator.pop(c, 'facebook'),
          ),
          ListTile(
            leading: const Icon(Icons.camera_alt_outlined),
            title: const Text('Instagram with a stream key'),
            subtitle: const Text('Another account; sent in vertical 9:16'),
            onTap: () => Navigator.pop(c, 'instagram'),
          ),
          ListTile(
            leading: const Icon(Icons.settings_input_antenna),
            title: const Text('Other service'),
            subtitle: const Text('Any RTMP stream URL and key'),
            onTap: () => Navigator.pop(c, 'other'),
          ),
          const SizedBox(height: 8),
        ]),
      ),
    );
    if (choice == null || !mounted) return;
    if (choice == 'channel') return _addChannelDestination();
    return _addKeyDestination(choice);
  }

  Future<void> _addChannelDestination() async {
    final orgId = _t.orgId ?? widget.session.selectedOrg?.id;
    if (orgId == null) return;
    final channels = await guarded(context, () => _api.youtubeChannels(orgId));
    if (channels == null || !mounted) return;
    final extra = channels.where((c) => !c.main).toList();
    final added = _outputs.destinations.map((d) => d.channelId).whereType<String>().toSet();
    var privacy = 'unlisted';
    final picked = await showDialog<String>(
      context: context,
      builder: (c) => StatefulBuilder(
        builder: (c, setLocal) => AlertDialog(
          title: const Text('Another YouTube channel'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                if (extra.isEmpty)
                  const Text('No other channel is connected yet. Connect one with Google sign-in; its owner signs in once.')
                else ...[
                  for (final ch in extra)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.smart_display),
                      title: Text(ch.title),
                      subtitle: added.contains(ch.id) ? const Text('Already a destination of this event') : null,
                      enabled: !added.contains(ch.id),
                      onTap: added.contains(ch.id) ? null : () => Navigator.pop(c, ch.id),
                    ),
                  const SizedBox(height: 8),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'public', label: Text('Public')),
                      ButtonSegment(value: 'unlisted', label: Text('Unlisted')),
                      ButtonSegment(value: 'private', label: Text('Private')),
                    ],
                    selected: {privacy},
                    onSelectionChanged: (v) => setLocal(() => privacy = v.first),
                  ),
                ],
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            TextButton.icon(onPressed: () => Navigator.pop(c, '+connect'), icon: const Icon(Icons.add_link), label: const Text('Connect a channel')),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    if (picked == '+connect') {
      final url = await guarded(context, () => _api.youtubeChannelConnectUrl(orgId));
      if (url == null || !mounted) return;
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
      if (mounted) toast(context, 'Sign in with the channel’s Google account, then come back and tap Add destination.');
      return;
    }
    setState(() => _busy = true);
    final r = await _withRoom(() => _api.addDestination(_t.id, {'kind': 'channel', 'channelId': picked, 'privacy': privacy}));
    if (mounted) setState(() => _busy = false);
    _applyDestinations(r);
    if (r != null && mounted) toast(context, 'Channel added. It goes live with the show.');
  }

  Future<void> _addKeyDestination(String platform) async {
    final (title, help, defaultUrl, urlHint) = switch (platform) {
      'youtube' => (
          'YouTube stream key',
          'In YouTube Studio for that channel: Create > Go live > Stream. Copy the stream key. The usual stream URL is filled in.',
          'rtmps://a.rtmps.youtube.com/live2',
          'rtmps://a.rtmps.youtube.com/live2',
        ),
      'facebook' => (
          'Facebook stream key',
          'On facebook.com: Live video > Streaming software. Copy the stream key (and the URL if it differs).',
          'rtmps://live-api-s.facebook.com:443/rtmp/',
          'rtmps://live-api-s.facebook.com:443/rtmp/',
        ),
      'instagram' => (
          'Instagram stream key',
          'On instagram.com with that professional account: Create (+) > Live video. Copy the stream URL and key. Instagram makes a new key every time.',
          '',
          'rtmps://edgetee-upload-…:443/rtmp/',
        ),
      _ => ('Other service', 'Paste the RTMP or RTMPS stream URL and key from the service.', '', 'rtmp://…'),
    };
    final label = TextEditingController();
    final url = TextEditingController(text: defaultUrl);
    final key = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text(help),
              const SizedBox(height: 12),
              TextField(controller: label, decoration: const InputDecoration(labelText: 'Name (optional)', hintText: 'Sponsor channel')),
              const SizedBox(height: 12),
              TextField(controller: url, autocorrect: false, decoration: InputDecoration(labelText: 'Stream URL', hintText: urlHint)),
              const SizedBox(height: 12),
              TextField(controller: key, autocorrect: false, decoration: const InputDecoration(labelText: 'Stream key')),
              if (platform == 'instagram') ...[
                const SizedBox(height: 8),
                Text('Sent as a vertical 9:16 picture.', style: Theme.of(c).textTheme.bodySmall),
              ],
            ]),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Add')),
        ],
      ),
    );
    final l = label.text.trim(), u = url.text.trim(), k = key.text.trim();
    label.dispose();
    url.dispose();
    key.dispose();
    if (ok != true || !mounted) return;
    if (k.isEmpty) {
      toast(context, 'Paste the stream key.', error: true);
      return;
    }
    setState(() => _busy = true);
    final r = await _withRoom(() => _api.addDestination(_t.id, {
          'kind': 'key',
          'platform': platform,
          if (u.isNotEmpty) 'streamUrl': u,
          'streamKey': k,
          if (l.isNotEmpty) 'label': l,
        }));
    if (mounted) setState(() => _busy = false);
    _applyDestinations(r);
  }

  Future<void> _toggleDestination(DestinationOutput d, bool on) async {
    _applyDestinations(await _withRoom(() => _api.updateDestination(_t.id, d.id, {'enabled': on})));
  }

  Future<void> _removeDestination(DestinationOutput d) async {
    final ok = await confirm(
      context,
      title: 'Remove ${d.label}?',
      message: 'The show stops going to this destination. Credits paid for extra destinations stay with this event.',
      action: 'Remove',
      destructive: true,
    );
    if (!ok || !mounted) return;
    _applyDestinations(await guarded(context, () => _api.removeDestination(_t.id, d.id)));
  }

  Widget _destinationRow(DestinationOutput d) {
    final (pill, color) = switch (d.state) {
      'live' => ('LIVE', Broadcast.onAir),
      'connecting' => ('CONNECTING', Broadcast.warning),
      'retrying' => ('RETRYING', Broadcast.warning),
      _ => (null, Broadcast.offline),
    };
    final what = d.isChannel ? 'YouTube channel${d.privacy != null ? ', ${d.privacy}' : ''}' : '${d.platformLabel} key …${d.hint ?? ''}';
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      secondary: IconButton(tooltip: 'Remove', icon: const Icon(Icons.delete_outline), onPressed: _busy ? null : () => _removeDestination(d)),
      title: Row(children: [
        Flexible(child: Text(d.label, overflow: TextOverflow.ellipsis)),
        if (pill != null) ...[const SizedBox(width: 8), StatusPill(label: pill, color: color, dense: true)],
      ]),
      subtitle: Text(d.error ?? (d.ready ? (d.link ?? what) : '$what · broadcast is made when you go live')),
      value: d.enabled,
      onChanged: _busy ? null : (v) => _toggleDestination(d, v),
    );
  }

  Future<void> _instagramKey() async {
    final url = TextEditingController();
    final key = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Instagram stream key'),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Text('On a computer, open instagram.com with the club’s professional account: Create (+) > Live video > '
                  'title and audience > copy the two values below. Instagram makes a new key every time, so do this '
                  'shortly before each event.'),
              const SizedBox(height: 12),
              TextField(controller: url, autocorrect: false, decoration: const InputDecoration(labelText: 'Stream URL', hintText: 'rtmps://edgetee-upload-…:443/rtmp/')),
              const SizedBox(height: 12),
              TextField(controller: key, autocorrect: false, decoration: const InputDecoration(labelText: 'Stream key')),
              const SizedBox(height: 8),
              Text('Instagram viewers get a vertical 9:16 version: the full picture with blurred bars above and below.',
                  style: Theme.of(c).textTheme.bodySmall),
            ]),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
        ],
      ),
    );
    final u = url.text.trim(), k = key.text.trim();
    url.dispose();
    key.dispose();
    if (ok != true || u.isEmpty || !mounted) return;
    final r = await _withRoom(() => _api.setOutputs(_t.id, {'instagram': {'streamUrl': u, 'streamKey': k}}));
    if (r != null && mounted) setState(() => _outputs = r);
    if (r != null) await _load(quiet: true);
  }

  String get _watchUrl => '${widget.session.serverUrl}/watch/${_t.id}';

  // ---------------------------------------------------------------- settings
  Future<void> _archive() async {
    final ok = await confirm(context,
        title: 'Archive ${_t.name}?',
        message: 'Volunteer codes stop working and it disappears from the list. Clips stay available.',
        action: 'Archive',
        destructive: true);
    if (!ok || !mounted) return;
    final r = await guarded(context, () => _api.updateTournament(_t.id, archived: true));
    if (r != null && mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    final cloud = _t.mode == ProductionMode.cloud;
    return Scaffold(
      appBar: AppBar(title: Text(_t.name, overflow: TextOverflow.ellipsis)),
      body: PageBody(
        onRefresh: _load,
        children: [
          if (_error != null) ...[InfoBanner(icon: Icons.error_outline, text: _error!, error: true), const SizedBox(height: 12)],
          if (!_loaded && _error == null) const LinearProgressIndicator(),
          InviteCard(api: _api, eventName: _t.name, invites: _invites, onManage: () => _push(JoinCodesScreen(session: s, tournament: _t))),
          _ActionGrid(children: [
            _Action(Icons.dashboard, 'Control room', 'Switch cameras, graphics, replays', () => _push(ControlRoomScreen(session: s, tournament: _t)), primary: true),
            _Action(Icons.scoreboard, 'Scoring', 'Enter scores, leaderboard', () => _push(ScorerScreen(session: s, tournament: _t))),
            _Action(Icons.movie, 'Clips', 'Highlights to share', () => _push(ClipsScreen(session: s, tournament: _t))),
            _Action(Icons.mic, 'Commentate', 'Talk over the broadcast', () => _push(CommentatorScreen(session: s, tournament: _t))),
            _Action(Icons.videocam, 'Use as camera', 'Stream from this phone', () => _push(CameraSetupScreen(session: s, tournament: _t))),
          ]),
          const SizedBox(height: 12),
          SectionCard(
            icon: Icons.settings_input_antenna,
            title: 'Production',
            children: [
              // Cloud is the normal way (no laptop). Laptop OBS stays available under Advanced.
              _EngineLine(engine: _engine),
              const SizedBox(height: 8),
              if (cloud) _CloudControls(production: _production, busy: _busy, onStart: _startCloud, onStop: _stopCloud),
              if (!cloud) ...[
                Text('A laptop running OBS at the venue mixes this event. Set it up once per event.', style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  OutlinedButton.icon(onPressed: _engineSetup, icon: const Icon(Icons.terminal), label: const Text('Engine setup (.env)')),
                  if (_production.cloudAvailable)
                    FilledButton.tonalIcon(
                      onPressed: _busy ? null : () => _setMode(ProductionMode.cloud),
                      icon: const Icon(Icons.cloud),
                      label: const Text('Use Cloud instead (no laptop)'),
                    ),
                ]),
              ],
              if (cloud)
                Theme(
                  data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    title: Text('Advanced', style: Theme.of(context).textTheme.titleSmall),
                    subtitle: Text('Mix on a laptop with OBS instead', style: Theme.of(context).textTheme.bodySmall),
                    children: [
                      Text('Only for venues with a laptop and good upload. Most events should stay on Cloud.', style: Theme.of(context).textTheme.bodySmall),
                      const SizedBox(height: 8),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: OutlinedButton.icon(
                          onPressed: _busy ? null : () => _setMode(ProductionMode.laptop),
                          icon: const Icon(Icons.laptop),
                          label: const Text('Switch to laptop OBS'),
                        ),
                      ),
                      const SizedBox(height: 8),
                    ],
                  ),
                ),
            ],
          ),
          if (_billing.enabled)
            SectionCard(
              icon: Icons.workspace_premium_outlined,
              title: 'Plan & credits',
              children: _planSection(context),
            ),
          SectionCard(
            icon: Icons.smart_display,
            title: 'YouTube',
            trailing: _youtube.hasBroadcast ? StatusPill(label: _youtube.statusLabel.toUpperCase(), color: _ytColor(_youtube), dense: true) : null,
            children: _youtubeSection(context),
          ),
          SectionCard(
            icon: Icons.cell_tower,
            title: 'Streaming platforms',
            children: _platformsSection(context),
          ),
          SectionCard(
            icon: Icons.public,
            title: 'Public watch page',
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Show on the watch page and the CoGolfers website'),
                subtitle: const Text('Live player, leaderboard and highlight clips, no login needed'),
                value: _t.publicWatch,
                onChanged: (v) => _run(() async => _t = await _api.updateTournament(_t.id, publicWatch: v)),
              ),
              if (_t.publicWatch) ...[
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Live chat on the watch page'),
                  subtitle: const Text('Viewers type a name and chat. YouTube and Facebook comments show in the same chat either way.'),
                  value: _t.chatEnabled,
                  onChanged: (v) => _run(() async => _t = await _api.updateTournament(_t.id, chatEnabled: v)),
                ),
                if (_t.chatEnabled)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Row(children: [
                      const Expanded(child: Text('Slow mode (one message per viewer every…)')),
                      DropdownButton<int>(
                        value: const [0, 3, 10, 30, 60].contains(_t.chatSlowSec) ? _t.chatSlowSec : 3,
                        items: const [
                          DropdownMenuItem(value: 0, child: Text('Off')),
                          DropdownMenuItem(value: 3, child: Text('3 s')),
                          DropdownMenuItem(value: 10, child: Text('10 s')),
                          DropdownMenuItem(value: 30, child: Text('30 s')),
                          DropdownMenuItem(value: 60, child: Text('1 min')),
                        ],
                        onChanged: (v) => v == null ? null : _run(() async => _t = await _api.updateTournament(_t.id, chatSlowSec: v)),
                      ),
                    ]),
                  ),
              ],
              if (_t.publicWatch)
                Wrap(spacing: 8, runSpacing: 8, children: [
                  OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse(_watchUrl), mode: LaunchMode.externalApplication), icon: const Icon(Icons.open_in_new), label: const Text('Open')),
                  OutlinedButton.icon(onPressed: () => SharePlus.instance.share(ShareParams(text: '${_t.name} live: $_watchUrl')), icon: const Icon(Icons.share), label: const Text('Share link')),
                  OutlinedButton.icon(
                    onPressed: () => copyText(
                      context,
                      '<iframe src="$_watchUrl" style="width:100%;aspect-ratio:16/10;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>',
                      'Website embed code',
                    ),
                    icon: const Icon(Icons.code),
                    label: const Text('Embed code'),
                  ),
                ]),
            ],
          ),
          SectionCard(
            icon: Icons.qr_code_2,
            title: 'Volunteers',
            children: [
              const Text('Camera operators, scorers and commentators join with a code or QR poster. No accounts.'),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonalIcon(
                  onPressed: () => _push(JoinCodesScreen(session: s, tournament: _t)),
                  icon: const Icon(Icons.qr_code),
                  label: const Text('Join codes & QR posters'),
                ),
              ),
            ],
          ),
          SectionCard(
            icon: Icons.golf_course,
            title: 'Course & players',
            children: [
              const Text('Pars for each hole and the player list (paste from a spreadsheet). Needed for scores and graphics.'),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonalIcon(
                  onPressed: () => _push(CourseScreen(session: s, tournament: _t)),
                  icon: const Icon(Icons.edit_note),
                  label: const Text('Course & players'),
                ),
              ),
            ],
          ),
          SectionCard(
            icon: Icons.tune,
            title: 'Settings',
            children: [
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Auto-fallback'),
                subtitle: const Text('Cut to the “back soon” scene if the on-air camera drops for 3 seconds'),
                value: _t.autoFallback,
                onChanged: (v) => _run(() async => _t = await _api.updateTournament(_t.id, autoFallback: v)),
              ),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(onPressed: _archive, icon: const Icon(Icons.archive_outlined), label: const Text('Archive tournament')),
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _platformsSection(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    final live = _engine.streaming.active;
    Widget row(StreamPlatform p, String notReady, {Widget? action}) {
      final o = _outputs.of(p);
      final (pill, color) = switch (o.state) {
        'live' => ('LIVE', Broadcast.onAir),
        'connecting' => ('CONNECTING', Broadcast.warning),
        'retrying' => ('RETRYING', Broadcast.warning),
        _ => (null, Broadcast.offline),
      };
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: Row(children: [
            Text(p.label),
            if (pill != null) ...[const SizedBox(width: 8), StatusPill(label: pill, color: color, dense: true)],
          ]),
          subtitle: Text(o.configured
              ? (o.error ?? (p == StreamPlatform.instagram && o.hint != null ? 'Key …${o.hint}' : (o.link ?? 'Ready')))
              : notReady),
          value: o.enabled && o.configured,
          onChanged: _busy || (!o.configured && !o.enabled) ? null : (v) => _setPlatform(p, v),
        ),
        if (action != null) Align(alignment: Alignment.centerLeft, child: action),
      ]);
    }

    return [
      Text('OBS sends one stream to the server, and the server sends it to each platform you switch on. '
          '${live ? 'Changes apply right away.' : ''}', style: small),
      const SizedBox(height: 4),
      row(StreamPlatform.youtube, _youtube.connected ? 'Create the broadcast in the YouTube card' : 'Connect YouTube under Organisation'),
      row(StreamPlatform.facebook, 'Connect the club’s Page under Organisation (people icon)'),
      row(
        StreamPlatform.instagram,
        'Paste the stream key from instagram.com before each event',
        action: TextButton.icon(
          onPressed: _busy ? null : _instagramKey,
          icon: const Icon(Icons.key),
          label: Text(_outputs.of(StreamPlatform.instagram).configured ? 'New Instagram key' : 'Paste Instagram key'),
        ),
      ),
      const Divider(height: 28),
      Row(children: [
        Expanded(child: Text('More destinations', style: Theme.of(context).textTheme.titleSmall)),
        if (_billing.enabled) Text('${_billing.destinationsUsed} of ${_billing.destinationLimit} included', style: small),
      ]),
      const SizedBox(height: 4),
      Text('Send the same show to more YouTube channels, Facebook or Instagram accounts, or any service with a stream key.', style: small),
      for (final d in _outputs.destinations) _destinationRow(d),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(onPressed: _busy ? null : _addDestination, icon: const Icon(Icons.add), label: const Text('Add destination')),
      ),
      if (!_outputs.relay)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('No platform switched on: a laptop OBS streams wherever its own settings say.', style: small),
        ),
    ];
  }

  static Color _ytColor(YoutubeState y) => switch (y.lifeCycleStatus) {
        'live' => Broadcast.onAir,
        'liveStarting' || 'testing' || 'testStarting' => Broadcast.warning,
        'complete' || 'revoked' => Broadcast.offline,
        _ => Broadcast.preview,
      };

  /// Where the main YouTube stream goes: Go Live channel (instant), my channel, or a pasted key.
  Future<void> _setSource(YoutubeSource src) async {
    if (src == _youtube.source) return;
    if (src == YoutubeSource.key) return _pasteYoutubeKey();
    await _run(() async {
      if (_youtube.source == YoutubeSource.key) await _api.clearYoutubeKey(_t.id);
      final y = await _api.setYoutubeSource(_t.id, src);
      if (mounted) setState(() => _youtube = y);
    });
  }

  Future<void> _pasteYoutubeKey({bool linkOnly = false}) async {
    final key = TextEditingController();
    final link = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(linkOnly ? 'YouTube video link' : 'Paste a YouTube stream key'),
        content: SizedBox(
          width: 420,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (!linkOnly) ...[
              Text('In YouTube Studio: Create > Go live > Stream. Copy the Stream key.', style: Theme.of(c).textTheme.bodySmall),
              const SizedBox(height: 8),
              TextField(controller: key, autofocus: true, autocorrect: false, decoration: const InputDecoration(labelText: 'Stream key', hintText: 'abcd-efgh-ijkl-mnop-qrst')),
              const SizedBox(height: 12),
            ],
            TextField(
              controller: link,
              autofocus: linkOnly,
              autocorrect: false,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(labelText: 'Video link (optional)', hintText: 'https://youtube.com/live/…', helperText: 'With the link, your watch page plays the video too.'),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Save')),
        ],
      ),
    );
    final k = key.text.trim(), l = link.text.trim();
    key.dispose();
    link.dispose();
    if (ok != true || !mounted || (!linkOnly && k.isEmpty)) return;
    await _run(() async {
      final y = await _api.setYoutubeKey(_t.id, streamKey: linkOnly ? null : k, videoUrl: l.isEmpty && !linkOnly ? null : l);
      if (mounted) setState(() => _youtube = y);
    });
  }

  Widget _sourcePicker(BuildContext context) {
    final y = _youtube;
    return SegmentedButton<YoutubeSource>(
      segments: [
        ButtonSegment(value: YoutubeSource.golive, label: const Text('Go Live channel'), icon: const Icon(Icons.bolt), enabled: y.goliveAvailable || y.source == YoutubeSource.golive),
        const ButtonSegment(value: YoutubeSource.org, label: Text('My YouTube'), icon: Icon(Icons.smart_display)),
        const ButtonSegment(value: YoutubeSource.key, label: Text('Stream key'), icon: Icon(Icons.key)),
      ],
      selected: {y.source},
      showSelectedIcon: false,
      onSelectionChanged: _busy || _engine.streaming.active ? null : (s) => _setSource(s.first),
    );
  }

  List<Widget> _youtubeSection(BuildContext context) {
    final y = _youtube;
    final small = Theme.of(context).textTheme.bodySmall;
    final picker = [_sourcePicker(context), const SizedBox(height: 8)];
    if (y.source == YoutubeSource.key) {
      final url = y.watchUrl;
      return [
        ...picker,
        Text(y.connected ? 'Streams with your pasted stream key.' : 'Paste the stream key from YouTube Studio.'),
        Text(url == null ? 'Add the video link so your watch page plays the video.' : 'Video: $url', style: small),
        const SizedBox(height: 8),
        Wrap(spacing: 8, runSpacing: 8, children: [
          OutlinedButton.icon(onPressed: _busy || _engine.streaming.active ? null : _pasteYoutubeKey, icon: const Icon(Icons.key), label: Text(y.connected ? 'Change key' : 'Paste key')),
          OutlinedButton.icon(onPressed: _busy ? null : () => _pasteYoutubeKey(linkOnly: true), icon: const Icon(Icons.link), label: Text(url == null ? 'Add video link' : 'Change link')),
          if (url != null) OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication), icon: const Icon(Icons.open_in_new), label: const Text('Watch')),
        ]),
      ];
    }
    if (!y.connected) {
      return [
        ...picker,
        if (y.source == YoutubeSource.golive)
          const Text('The Go Live channel is switched off right now. Use your own channel or a stream key.')
        else ...[
          const Text('Your organisation has not connected a YouTube channel.'),
          const SizedBox(height: 4),
          Text(
              y.goliveAvailable
                  ? 'Choose “Go Live channel” to stream now with nothing to set up, paste a stream key, or have the owner connect your channel under Organisation (people icon on the home screen).'
                  : 'Paste a stream key, or have the owner connect your channel under Organisation (people icon on the home screen).',
              style: small),
        ],
      ];
    }
    if (!y.hasBroadcast) {
      return [
        ...picker,
        Text(y.source == YoutubeSource.golive ? 'On the Go Live channel (${y.channelTitle ?? ''}), unlisted: share your watch page link.' : 'Channel: ${y.channelTitle ?? ''}'),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: FilledButton.icon(onPressed: _busy ? null : _createBroadcast, icon: const Icon(Icons.add), label: const Text('Create broadcast')),
        ),
      ];
    }
    final url = y.watchUrl;
    return [
      ...picker,
      Text('Channel: ${y.channelTitle ?? ''} · ${y.privacy ?? ''}'),
      if (y.streamStatus != null) Text('Signal: ${y.streamStatus}${y.health != null ? ' · health ${y.health}' : ''}', style: small),
      for (final issue in y.issues.take(3)) Text('• $issue', style: small?.copyWith(color: Broadcast.warning)),
      if (y.error != null) Text(y.error!, style: small?.copyWith(color: Broadcast.warning)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        if (url != null) ...[
          OutlinedButton.icon(onPressed: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication), icon: const Icon(Icons.open_in_new), label: const Text('Watch')),
          OutlinedButton.icon(onPressed: () => SharePlus.instance.share(ShareParams(text: '${_t.name} live: $url')), icon: const Icon(Icons.share), label: const Text('Share link')),
        ],
        TextButton(onPressed: _busy || _engine.streaming.active ? null : _forgetBroadcast, child: const Text('New broadcast')),
      ]),
    ];
  }
}

class _EngineLine extends StatelessWidget {
  const _EngineLine({required this.engine});
  final EngineState engine;

  @override
  Widget build(BuildContext context) {
    final (label, color) = !engine.connected
        ? ('Engine not connected', Broadcast.offline)
        : (!engine.obsConnected ? ('Engine connected, OBS not reachable', Broadcast.warning) : ('Engine ready · OBS ${engine.obsVersion ?? ''}', Broadcast.preview));
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Icon(Icons.circle, size: 12, color: color),
        const SizedBox(width: 8),
        Expanded(child: Text(label)),
        if (engine.streaming.active) const StatusPill(label: 'LIVE', color: Broadcast.onAir, dense: true),
      ]),
      for (final w in engine.warnings) Padding(padding: const EdgeInsets.only(top: 4), child: Text('⚠ $w', style: const TextStyle(color: Broadcast.warning, fontSize: 12.5))),
    ]);
  }
}

class _CloudControls extends StatefulWidget {
  const _CloudControls({required this.production, required this.busy, required this.onStart, required this.onStop});
  final ProductionState production;
  final bool busy;
  final VoidCallback onStart;
  final VoidCallback onStop;

  @override
  State<_CloudControls> createState() => _CloudControlsState();
}

class _CloudControlsState extends State<_CloudControls> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && widget.production.startedAt != null) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.production;
    final now = DateTime.now();
    final running = p.cloudStatus == CloudEngineStatus.running;
    final (label, color) = switch (p.cloudStatus) {
      CloudEngineStatus.stopped => ('STOPPED', Broadcast.offline),
      CloudEngineStatus.starting => ('STARTING', Broadcast.warning),
      CloudEngineStatus.running => ('RUNNING', Broadcast.preview),
      CloudEngineStatus.stopping => ('STOPPING', Broadcast.warning),
      CloudEngineStatus.error => ('ERROR', Broadcast.onAir),
    };
    final small = Theme.of(context).textTheme.bodySmall;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        StatusPill(label: 'CLOUD $label', color: color, icon: Icons.cloud),
        const SizedBox(width: 10),
        if (p.startedAt != null && p.cloudStatus != CloudEngineStatus.stopped)
          Expanded(
            child: Text(
              '${formatDuration(now.difference(p.startedAt!))}'
              '${p.costPerHour > 0 ? ' · ≈ ${formatMoney(p.costSoFar(now))} so far' : ''}',
              style: small,
            ),
          ),
      ]),
      if (p.error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(p.error!, style: small?.copyWith(color: Broadcast.warning))),
      const SizedBox(height: 8),
      Text(
        'OBS runs on the server: cameras, commentary and graphics are mixed there and sent to YouTube. '
        '${p.autoStopAfterIdleMin > 0 ? 'Stops automatically after ${p.autoStopAfterIdleMin} min without streaming. ' : ''}'
        '${p.costPerHour > 0 ? 'About ${formatMoney(p.costPerHour)}/hour while running.' : ''}',
        style: small,
      ),
      const SizedBox(height: 10),
      Row(children: [
        if (!running && p.cloudStatus != CloudEngineStatus.starting)
          FilledButton.icon(onPressed: widget.busy || p.cloudBusy ? null : widget.onStart, icon: const Icon(Icons.play_arrow), label: const Text('Start cloud engine')),
        if (running || p.cloudStatus == CloudEngineStatus.starting)
          OutlinedButton.icon(onPressed: widget.busy || p.cloudStatus == CloudEngineStatus.stopping ? null : widget.onStop, icon: const Icon(Icons.stop), label: const Text('Stop')),
      ]),
    ]);
  }
}

class _Action {
  const _Action(this.icon, this.title, this.subtitle, this.onTap, {this.primary = false});
  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool primary;
}

class _ActionGrid extends StatelessWidget {
  const _ActionGrid({required this.children});
  final List<_Action> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final columns = c.maxWidth > 600 ? 3 : 2;
      final w = (c.maxWidth - (columns - 1) * 10) / columns;
      return Wrap(spacing: 10, runSpacing: 10, children: [
        for (final a in children)
          SizedBox(
            width: w,
            child: Card(
              margin: EdgeInsets.zero,
              color: a.primary ? Broadcast.course : null,
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: a.onTap,
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Icon(a.icon, size: 28),
                    const SizedBox(height: 8),
                    Text(a.title, style: Theme.of(context).textTheme.titleSmall),
                    Text(a.subtitle, style: Theme.of(context).textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                  ]),
                ),
              ),
            ),
          ),
      ]);
    });
  }
}

class _PlanRow extends StatelessWidget {
  const _PlanRow({required this.icon, required this.title, required this.subtitle, this.action, this.warn = false});
  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? action;
  final bool warn;

  @override
  Widget build(BuildContext context) => ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, color: warn ? Broadcast.warning : null),
        title: Text(title, style: TextStyle(fontWeight: FontWeight.w600, color: warn ? Broadcast.warning : null)),
        subtitle: Text(subtitle),
        trailing: action,
      );
}
