/// What a volunteer scanned or typed: the server to use (if the QR said) and the join code.
class JoinLink {
  const JoinLink({this.server, required this.code});
  final String? server;
  final String code;

  @override
  String toString() => 'JoinLink($server, $code)';
}

/// Same rule as the server: upper case, letters and digits only ("abc-123" -> "ABC123").
String normaliseJoinCode(String input) => input.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

/// Understands the QR poster URL ("https://live.club.com/join/ABC123"), a pasted link
/// without scheme, or a bare code. Returns null if nothing usable is in [raw].
JoinLink? parseJoinLink(String raw) {
  final s = raw.trim();
  if (s.isEmpty) return null;
  final m = RegExp(r'^(?:(https?)://)?([^/\s]+(?:/[^\s]*?)?)/join/([A-Za-z0-9-]{4,20})/?(?:[?#].*)?$').firstMatch(s);
  if (m != null) {
    final scheme = m.group(1) ?? 'https';
    final code = normaliseJoinCode(m.group(3)!);
    if (code.length < 4) return null;
    return JoinLink(server: '$scheme://${m.group(2)}', code: code);
  }
  if (RegExp(r'^[A-Za-z0-9 -]{4,24}$').hasMatch(s)) {
    final code = normaliseJoinCode(s);
    return code.length >= 4 && code.length <= 20 ? JoinLink(code: code) : null;
  }
  return null;
}

/// A "log in on the app" QR from the website's Account page: `https://<server>/app/login/<code>`.
class LoginLink {
  const LoginLink({required this.server, required this.code});
  final String server;
  final String code;
}

LoginLink? parseLoginLink(String raw) {
  final m = RegExp(r'^(https?)://([^/\s]+(?:/[^\s]*?)?)/app/login/([A-Za-z0-9_-]{20,100})/?$').firstMatch(raw.trim());
  if (m == null) return null;
  return LoginLink(server: '${m.group(1)}://${m.group(2)}', code: m.group(3)!);
}
