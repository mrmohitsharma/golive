import 'package:cg_streamer/cg_streamer.dart';
import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../core/join_link.dart';
import '../../core/session.dart';
import '../../ui/legal.dart';
import '../../ui/widgets.dart';
import 'qr_scan_screen.dart';

enum _Mode { join, signIn, signUp }

/// First screen. Volunteers join with the code on the QR poster (no account); organisers
/// and staff sign in; a new organiser creates an account and their club.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.session});
  final Session session;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  late final _server = TextEditingController(text: widget.session.serverUrl);
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  final _org = TextEditingController();
  final _code = TextEditingController();
  _Mode _mode = _Mode.join;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [_server, _email, _password, _name, _org, _code]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _scan() async {
    final link = await Navigator.of(context).push<JoinLink>(MaterialPageRoute(builder: (_) => const QrScanScreen()));
    if (link == null || !mounted) return;
    setState(() {
      _code.text = link.code;
      if (link.server != null) _server.text = link.server!;
      _error = null;
    });
  }

  String? _validate() {
    if (_server.text.trim().isEmpty) return 'Enter the server address (it is printed on the QR poster).';
    switch (_mode) {
      case _Mode.join:
        if (parseJoinLink(_code.text) == null) return 'Enter the code from the organiser, or scan the QR poster.';
        if (_name.text.trim().isEmpty) return 'Enter your name so the director knows who you are.';
      case _Mode.signIn:
        if (_email.text.trim().isEmpty || _password.text.isEmpty) return 'Enter your email and password.';
      case _Mode.signUp:
        if (_name.text.trim().isEmpty || _org.text.trim().length < 2) return 'Enter your name and your club or organisation.';
        if (_email.text.trim().isEmpty) return 'Enter your email.';
        if (_password.text.length < 8) return 'Choose a password of at least 8 characters.';
    }
    return null;
  }

  Future<void> _submit() async {
    final problem = _validate();
    if (problem != null) return setState(() => _error = problem);
    setState(() {
      _busy = true;
      _error = null;
    });
    final s = widget.session;
    try {
      switch (_mode) {
        case _Mode.join:
          final link = parseJoinLink(_code.text)!;
          await s.joinWithCode(link.server ?? _server.text, code: link.code, name: _name.text, deviceId: await CgStreamer.deviceId());
        case _Mode.signIn:
          await s.signIn(_server.text, _email.text, _password.text);
        case _Mode.signUp:
          await s.signUp(_server.text, name: _name.text, email: _email.text, password: _password.text, orgName: _org.text);
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } on FormatException {
      setState(() => _error = 'The server address is not valid.');
    } on Exception catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: AutofillGroup(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.live_tv, size: 56, color: Broadcast.onAir),
                    const SizedBox(height: 8),
                    Text('Go Live', textAlign: TextAlign.center, style: theme.textTheme.headlineSmall),
                    const SizedBox(height: 4),
                    Text('Broadcast any event live, from phones', textAlign: TextAlign.center, style: theme.textTheme.bodyMedium),
                    const SizedBox(height: 24),
                    SegmentedButton<_Mode>(
                      segments: const [
                        ButtonSegment(value: _Mode.join, label: Text('Join'), icon: Icon(Icons.qr_code_2)),
                        ButtonSegment(value: _Mode.signIn, label: Text('Sign in'), icon: Icon(Icons.login)),
                        ButtonSegment(value: _Mode.signUp, label: Text('New club'), icon: Icon(Icons.add_business)),
                      ],
                      selected: {_mode},
                      showSelectedIcon: false,
                      onSelectionChanged: (m) => setState(() {
                        _mode = m.first;
                        _error = null;
                      }),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      switch (_mode) {
                        _Mode.join => 'Volunteering as a camera operator, scorer or commentator? Scan the QR poster from the organiser. No account needed.',
                        _Mode.signIn => 'Organisers, directors and club staff.',
                        _Mode.signUp => 'Create your organiser account and club. You can invite staff and volunteers next.',
                      },
                      style: theme.textTheme.bodySmall,
                    ),
                    const SizedBox(height: 20),
                    if (_mode == _Mode.join) ...[
                      OutlinedButton.icon(
                        onPressed: _busy ? null : _scan,
                        icon: const Icon(Icons.qr_code_scanner),
                        label: const Text('Scan QR poster'),
                        style: OutlinedButton.styleFrom(minimumSize: const Size(0, 52)),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _code,
                        textCapitalization: TextCapitalization.characters,
                        autocorrect: false,
                        decoration: const InputDecoration(labelText: 'Join code', hintText: 'ABC-123'),
                      ),
                      const SizedBox(height: 12),
                    ],
                    TextField(
                      controller: _server,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      decoration: const InputDecoration(labelText: 'Server', hintText: 'live.yourclub.com'),
                    ),
                    const SizedBox(height: 12),
                    if (_mode != _Mode.signIn) ...[
                      TextField(
                        controller: _name,
                        textCapitalization: TextCapitalization.words,
                        autofillHints: const [AutofillHints.name],
                        decoration: const InputDecoration(labelText: 'Your name'),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_mode == _Mode.signUp) ...[
                      TextField(
                        controller: _org,
                        textCapitalization: TextCapitalization.words,
                        decoration: const InputDecoration(labelText: 'Club or organisation', hintText: 'Your club, school or company'),
                      ),
                      const SizedBox(height: 12),
                    ],
                    if (_mode != _Mode.join) ...[
                      TextField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(labelText: 'Email'),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _password,
                        obscureText: true,
                        autofillHints: [_mode == _Mode.signUp ? AutofillHints.newPassword : AutofillHints.password],
                        decoration: InputDecoration(labelText: _mode == _Mode.signUp ? 'Password (8+ characters)' : 'Password'),
                        onSubmitted: (_) => _submit(),
                      ),
                    ],
                    if (_mode == _Mode.signUp) ...[
                      const SizedBox(height: 14),
                      LegalConsent(serverUrl: () => _server.text),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      InfoBanner(icon: Icons.error_outline, text: _error!, error: true),
                    ],
                    const SizedBox(height: 24),
                    FilledButton(
                      style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                          : Text(switch (_mode) {
                              _Mode.join => 'Join tournament',
                              _Mode.signIn => 'Sign in',
                              _Mode.signUp => 'Create account',
                            }),
                    ),
                    const SizedBox(height: 12),
                    LegalFooter(serverUrl: () => _server.text),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
