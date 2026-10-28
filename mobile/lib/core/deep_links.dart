import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'join_link.dart';
import 'session.dart';

/// Links that open the app (onboarding P1-9):
///  - https://<server>/join/<code>      → join screen with the code filled in
///  - https://<server>/app/login/<code> → signed in to the website's account
class DeepLinks {
  DeepLinks(this.session, this.navigatorKey);
  final Session session;
  final GlobalKey<NavigatorState> navigatorKey;
  final _links = AppLinks();
  StreamSubscription<Uri>? _sub;
  String? _last;
  DateTime _lastAt = DateTime.fromMillisecondsSinceEpoch(0);

  Future<void> start() async {
    _sub = _links.uriLinkStream.listen(_handle, onError: (Object _) {});
    try {
      final first = await _links.getInitialLink();
      if (first != null) _handle(first);
    } on Object {
      // No launch link.
    }
  }

  void dispose() => _sub?.cancel();

  Future<void> _handle(Uri uri) async {
    // The launch link can arrive both from the stream and getInitialLink.
    final s = uri.toString();
    if (s == _last && DateTime.now().difference(_lastAt) < const Duration(seconds: 5)) return;
    _last = s;
    _lastAt = DateTime.now();
    while (!session.loaded) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    final login = parseLoginLink(s);
    if (login != null) return _login(login);
    final join = parseJoinLink(s);
    if (join != null && join.server != null) return _join(join);
  }

  Future<void> _login(LoginLink link) async {
    if (session.signedIn && !session.isGuest) return _toast('You are already signed in.');
    try {
      await session.redeemHandoff(link.server, link.code);
    } on ApiException catch (e) {
      _toast(e.message);
    }
  }

  Future<void> _join(JoinLink link) async {
    final ctx = navigatorKey.currentContext;
    if (session.signedIn && !session.isGuest && ctx != null) {
      final ok = await showDialog<bool>(
        context: ctx,
        builder: (c) => AlertDialog(
          title: const Text('Join as a volunteer?'),
          content: const Text('This link joins an event as a camera, scorer or commentator. You will be signed out of your account on this phone.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Join')),
          ],
        ),
      );
      if (ok != true) return;
    }
    navigatorKey.currentState?.popUntil((r) => r.isFirst);
    session.setPendingJoin(link);
    // A volunteer pass (or account) on this phone gives way to the new event.
    if (session.signedIn) await session.signOut();
  }

  void _toast(String text) {
    final ctx = navigatorKey.currentContext;
    if (ctx != null) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text(text)));
  }
}
