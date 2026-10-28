import 'package:google_sign_in/google_sign_in.dart';

import 'app_config.dart';

/// Gets a Google ID token for our server (google_sign_in 7.x). The audience is the Web
/// client ID (`serverClientId`), which the server checks. Returns null if the person cancels.
class GoogleAuth {
  GoogleAuth._();

  static Future<void>? _init;

  static Future<void> _initialise() => _init ??= GoogleSignIn.instance.initialize(
        clientId: kGoogleIosClientId.isEmpty ? null : kGoogleIosClientId,
        serverClientId: kGoogleWebClientId,
      );

  static Future<String?> idToken() async {
    await _initialise();
    try {
      final account = await GoogleSignIn.instance.authenticate(scopeHint: const ['email', 'profile']);
      final token = account.authentication.idToken;
      if (token == null || token.isEmpty) throw StateError('Google did not return an ID token. Check GOOGLE_WEB_CLIENT_ID.');
      return token;
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) return null;
      rethrow;
    }
  }

  /// So the next "Continue with Google" shows the account chooser again.
  static Future<void> signOut() async {
    if (_init == null) return;
    try {
      await GoogleSignIn.instance.signOut();
    } on Object {
      // Not signed in with Google on this phone: nothing to do.
    }
  }
}
