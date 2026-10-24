import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/models.dart';
import '../../core/session.dart';
import '../../ui/widgets.dart';

enum _Filter { all, questions, open }

/// Viewer comments from the CoGolfers watch page, YouTube and Facebook in one list.
/// Commentators read questions out and tick them answered; directors ([canModerate])
/// also put a question on air, pin it to the watch page, hide it or block the author.
class ChatPanel extends StatefulWidget {
  const ChatPanel({super.key, required this.session, required this.tournament, this.canModerate = false, this.dark = true});
  final Session session;
  final Tournament tournament;
  final bool canModerate;
  final bool dark;

  @override
  State<ChatPanel> createState() => _ChatPanelState();
}

class _ChatPanelState extends State<ChatPanel> {
  late final ApiClient _api = widget.session.api();
  final _scroll = ScrollController();
  ChatFeed _feed = const ChatFeed();
  bool _loaded = false;
  String? _error;
  _Filter _filter = _Filter.all;
  bool _followNewest = true;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      _followNewest = _scroll.position.maxScrollExtent - _scroll.offset < 80;
    });
    _poll();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _scroll.dispose();
    _api.close();
    super.dispose();
  }

  Future<void> _poll({bool force = false}) async {
    _timer?.cancel();
    try {
      final f = await _api.chatFeed(widget.tournament.id, version: force || !_loaded ? null : _feed.version);
      if (!mounted) return;
      if (f != null || !_loaded) {
        setState(() {
          if (f != null) _feed = f;
          _loaded = true;
          _error = null;
        });
        if (_followNewest) WidgetsBinding.instance.addPostFrameCallback((_) => _toBottom());
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) _timer = Timer(const Duration(seconds: 2), _poll);
  }

  void _toBottom() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  List<ChatMessage> get _shown {
    final all = widget.canModerate ? _feed.messages : _feed.messages.where((m) => !m.hidden).toList();
    return switch (_filter) {
      _Filter.all => all,
      _Filter.questions => all.where((m) => m.question).toList(),
      _Filter.open => all.where((m) => m.question && !m.answered).toList(),
    };
  }

  Future<void> _act(Future<void> Function() call, [String? done]) async {
    final ok = await guarded(context, () async {
      await call();
      return true;
    });
    if (ok == true && done != null && mounted) toast(context, done);
    await _poll(force: true);
  }

  Future<void> _actions(ChatMessage m) async {
    final mod = widget.canModerate;
    final choice = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: _SourceBadge(m.source),
            title: Text(m.author, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(m.text),
          ),
          const Divider(height: 1),
          ListTile(
            leading: Icon(m.answered ? Icons.undo : Icons.check_circle_outline),
            title: Text(m.answered ? 'Mark not answered' : 'Mark answered'),
            onTap: () => Navigator.pop(c, 'answered'),
          ),
          if (mod) ...[
            ListTile(leading: const Icon(Icons.live_tv, color: Broadcast.onAir), title: const Text('Show on air (viewer question)'), onTap: () => Navigator.pop(c, 'onair')),
            ListTile(
              leading: Icon(m.pinned ? Icons.push_pin_outlined : Icons.push_pin),
              title: Text(m.pinned ? 'Unpin from the watch page' : 'Pin on the watch page'),
              onTap: () => Navigator.pop(c, 'pin'),
            ),
            ListTile(
              leading: Icon(m.hidden ? Icons.visibility : Icons.visibility_off),
              title: Text(m.hidden ? 'Show again' : 'Hide from the watch page'),
              onTap: () => Navigator.pop(c, 'hide'),
            ),
            ListTile(
              leading: const Icon(Icons.block, color: Broadcast.onAir),
              title: Text('Block ${m.author}'),
              subtitle: const Text('Hides all their messages in this tournament'),
              onTap: () => Navigator.pop(c, 'block'),
            ),
          ],
        ]),
      ),
    );
    if (!mounted || choice == null) return;
    switch (choice) {
      case 'answered':
        await _act(() => _api.updateChatMessage(m.id, answered: !m.answered));
      case 'onair':
        await _act(() => _api.chatOnAir(m.id), 'On air. Take it off from Graphics or here.');
      case 'pin':
        await _act(() => _api.updateChatMessage(m.id, pinned: !m.pinned));
      case 'hide':
        await _act(() => _api.updateChatMessage(m.id, hidden: !m.hidden));
      case 'block':
        final ok = await confirm(context,
            title: 'Block ${m.author}?', message: 'Their messages are hidden and they cannot post again in this tournament.', action: 'Block', destructive: true);
        if (ok) await _act(() => _api.blockChatAuthor(m.id), '${m.author} blocked');
    }
  }

  @override
  Widget build(BuildContext context) {
    final shown = _shown;
    final open = _feed.messages.where((m) => m.question && !m.answered && !m.hidden).length;
    final fg = widget.dark ? Colors.white : null;
    return Container(
      decoration: widget.dark ? BoxDecoration(color: Broadcast.panel, borderRadius: BorderRadius.circular(12)) : null,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: Row(children: [
            Text('VIEWER COMMENTS', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1, color: fg)),
            const Spacer(),
            _SourceState(label: 'YouTube', s: _feed.youtube),
            const SizedBox(width: 6),
            _SourceState(label: 'Facebook', s: _feed.facebook),
          ]),
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(children: [
            for (final (f, label) in [(_Filter.all, 'All'), (_Filter.questions, 'Questions'), (_Filter.open, 'Not answered ($open)')])
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: ChoiceChip(label: Text(label), selected: _filter == f, onSelected: (_) => setState(() => _filter = f), visualDensity: VisualDensity.compact),
              ),
            if (!_feed.enabled) const Padding(padding: EdgeInsets.only(left: 4), child: Text('Watch-page chat is off', style: TextStyle(color: Broadcast.warning, fontSize: 12))),
          ]),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(8), child: InfoBanner(icon: Icons.cloud_off, text: _error!, error: true)),
        for (final s in [_feed.youtube, _feed.facebook])
          if (s.state == 'error' && s.error != null)
            Padding(padding: const EdgeInsets.fromLTRB(12, 6, 12, 0), child: Text('⚠ ${s.error}', style: const TextStyle(color: Broadcast.warning, fontSize: 12))),
        Expanded(
          child: !_loaded
              ? const Center(child: CircularProgressIndicator())
              : shown.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          _filter == _Filter.all ? 'No comments yet. They appear here from the watch page, YouTube and Facebook.' : 'No questions here.',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white54),
                        ),
                      ),
                    )
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      itemCount: shown.length,
                      itemBuilder: (_, i) => _MessageTile(m: shown[i], dark: widget.dark, onTap: () => _actions(shown[i])),
                    ),
        ),
      ]),
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.m, required this.dark, required this.onTap});
  final ChatMessage m;
  final bool dark;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final dim = m.hidden || m.answered;
    final highlight = m.question && !m.answered && !m.hidden;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: highlight ? Broadcast.course.withValues(alpha: 0.55) : null,
          border: Border(left: BorderSide(color: highlight ? const Color(0xFFC9A227) : Colors.transparent, width: 3)),
        ),
        child: Opacity(
          opacity: dim ? 0.5 : 1,
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _SourceBadge(m.source),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Flexible(child: Text(m.author, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, color: Color(0xFFCFE6D8), fontSize: 13))),
                  const SizedBox(width: 6),
                  Text(_time(m.at), style: const TextStyle(color: Colors.white38, fontSize: 11)),
                  if (m.pinned) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.push_pin, size: 13, color: Color(0xFFC9A227))),
                  if (m.answered) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.check_circle, size: 13, color: Broadcast.preview)),
                  if (m.hidden) const Padding(padding: EdgeInsets.only(left: 6), child: Text('HIDDEN', style: TextStyle(color: Broadcast.onAir, fontSize: 10, fontWeight: FontWeight.w800))),
                ]),
                const SizedBox(height: 2),
                // Large enough to read aloud from a tablet at arm's length.
                Text(m.text, style: TextStyle(fontSize: 16, height: 1.3, color: dark ? Colors.white : null)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }

  static String _time(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
}

class _SourceBadge extends StatelessWidget {
  const _SourceBadge(this.source);
  final ChatSource source;

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (source) {
      ChatSource.youtube => (const Color(0xFFFF0033), Icons.play_arrow),
      ChatSource.facebook => (const Color(0xFF1877F2), Icons.facebook),
      ChatSource.watch => (const Color(0xFF2E7D4F), Icons.golf_course),
    };
    return Tooltip(
      message: source.label,
      child: Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(5)),
        child: Icon(icon, size: 15, color: Colors.white),
      ),
    );
  }
}

class _SourceState extends StatelessWidget {
  const _SourceState({required this.label, required this.s});
  final String label;
  final ChatSourceStatus s;

  @override
  Widget build(BuildContext context) {
    final color = switch (s.state) {
      'reading' => Broadcast.preview,
      'error' => Broadcast.warning,
      _ => Broadcast.offline,
    };
    return Tooltip(
      message: s.state == 'reading' ? 'Reading $label comments' : (s.error ?? '$label comments are read while you are live there'),
      child: StatusPill(label: label.toUpperCase(), color: color, dense: true),
    );
  }
}

/// Full-screen comments for the control room.
class ChatScreen extends StatelessWidget {
  const ChatScreen({super.key, required this.session, required this.tournament, this.canModerate = true});
  final Session session;
  final Tournament tournament;
  final bool canModerate;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Broadcast.panel,
        appBar: AppBar(title: const Text('Viewer comments')),
        body: SafeArea(child: ChatPanel(session: session, tournament: tournament, canModerate: canModerate)),
      );
}
