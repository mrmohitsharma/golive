/// Build-time settings, passed with `--dart-define` (see docs/MOBILE.md).

/// The Go Live server the app talks to. Built in, so nobody types a server address:
/// `flutter build appbundle --dart-define=SERVER_URL=https://icca.co.in`.
/// A different server can still be chosen for testing (long-press the logo on the first screen).
const String kDefaultServer = String.fromEnvironment('SERVER_URL', defaultValue: 'https://icca.co.in');

/// Google sign-in: the OAuth client IDs of the Go Live Google Cloud project (P1-2).
/// The Web client ID is what the server checks as the token's audience; Android needs it too
/// (`serverClientId`) so the ID token is issued for our server.
const String kGoogleWebClientId = String.fromEnvironment('GOOGLE_WEB_CLIENT_ID');
const String kGoogleIosClientId = String.fromEnvironment('GOOGLE_IOS_CLIENT_ID');

bool get googleSignInConfigured => kGoogleWebClientId.isNotEmpty;
