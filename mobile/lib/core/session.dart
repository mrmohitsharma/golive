import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'app_config.dart';
import 'google_auth.dart';
import 'models.dart';

/// Who is using the app:
/// - an account (organiser, director, staff): user + organisations
/// - a volunteer who joined one tournament with a code: guest pass, no account
/// Persisted so people stay signed in through restarts during a tournament day.
class Session extends ChangeNotifier {
  static const _kServer = 'cg.server';
  static const _kToken = 'cg.token';
  static const _kUser = 'cg.user';
  static const _kOrgs = 'cg.orgs';
  static const _kGuest = 'cg.guest';
  static const _kOrg = 'cg.org';

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  String serverUrl = kDefaultServer;

  /// True when a tester chose a server other than the built-in one.
  bool get customServer => normaliseServer(serverUrl) != normaliseServer(kDefaultServer);
  String? token;
  AppUser? user;
  List<OrgMembership> orgs = const [];
  GuestPass? guest;
  String? selectedOrgId;
  bool loaded = false;

  bool get signedIn => token != null && (user != null || guest != null);
  bool get isGuest => guest != null;

  /// Display name for the person holding this phone.
  String get displayName => user?.name ?? guest?.name ?? '';

  OrgMembership? get selectedOrg {
    for (final o in orgs) {
      if (o.id == selectedOrgId) return o;
    }
    return orgs.isEmpty ? null : orgs.first;
  }

  ApiClient api() => ApiClient(baseUrl: serverUrl, token: token);

  Future<void> load() async {
    final p = await _prefs;
    final saved = p.getString(_kServer);
    serverUrl = (saved == null || saved.trim().isEmpty) ? kDefaultServer : saved;
    token = p.getString(_kToken);
    selectedOrgId = p.getString(_kOrg);
    try {
      final u = p.getString(_kUser);
      user = u == null ? null : AppUser.fromJson(jsonDecode(u) as Map<String, dynamic>);
      final o = p.getString(_kOrgs);
      orgs = o == null
          ? const []
          : (jsonDecode(o) as List).map((e) => OrgMembership.fromJson(e as Map<String, dynamic>)).toList();
      final g = p.getString(_kGuest);
      guest = g == null ? null : GuestPass.fromJson(jsonDecode(g) as Map<String, dynamic>);
    } on Object {
      user = null;
      guest = null;
    }
    loaded = true;
    notifyListeners();
    if (signedIn) await refresh();
  }

  /// Validates the stored token and refreshes organisations. Signs out only if the server
  /// says the token is invalid, not when the network is down (a camera operator may open
  /// the app before signal returns).
  Future<void> refresh() async {
    final client = api();
    try {
      final me = await client.me();
      final principal = (me['principal'] as Map<String, dynamic>?) ?? const {};
      if (principal['kind'] == 'user') {
        user = AppUser.fromJson(principal);
        orgs = ((me['orgs'] as List?) ?? const []).map((o) => OrgMembership.fromJson(o as Map<String, dynamic>)).toList();
        await _saveAccount();
      }
      notifyListeners();
    } on ApiException catch (e) {
      if (e.isAuth) await signOut();
    } finally {
      client.close();
    }
  }

  static String normaliseServer(String input) {
    var s = input.trim();
    if (s.isEmpty) s = kDefaultServer;
    if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'https://$s';
    return s.replaceAll(RegExp(r'/+$'), '');
  }

  Future<void> signIn(String server, String email, String password) async {
    final url = normaliseServer(server);
    final client = ApiClient(baseUrl: url);
    try {
      _adoptAccount(url, await client.login(email.trim(), password));
    } finally {
      client.close();
    }
    await _saveAccount();
    notifyListeners();
  }

  /// Self-serve: organiser account + their club in one step.
  Future<void> signUp(String server, {required String name, required String email, required String password, required String orgName}) async {
    final url = normaliseServer(server);
    final client = ApiClient(baseUrl: url);
    try {
      _adoptAccount(url, await client.signup(name: name.trim(), email: email.trim(), password: password, orgName: orgName.trim()));
    } finally {
      client.close();
    }
    await _saveAccount();
    notifyListeners();
  }

  /// Organiser with Google: one tap, no password. Returns true for a brand-new account.
  Future<bool> signInWithGoogle(String server, String idToken, {String? orgName}) async {
    final url = normaliseServer(server);
    final client = ApiClient(baseUrl: url);
    final bool created;
    try {
      final (s, isNew) = await client.googleSignIn(idToken, orgName: orgName);
      _adoptAccount(url, s);
      created = isNew;
    } finally {
      client.close();
    }
    await _saveAccount();
    notifyListeners();
    return created;
  }

  /// Signed up on the website: scan its QR to sign in here without typing.
  Future<void> redeemHandoff(String server, String code) async {
    final url = normaliseServer(server);
    final client = ApiClient(baseUrl: url);
    try {
      _adoptAccount(url, await client.redeemHandoff(code));
    } finally {
      client.close();
    }
    await _saveAccount();
    notifyListeners();
  }

  /// Volunteer: join one tournament with the code from the QR poster.
  Future<void> joinWithCode(String server, {required String code, required String name, required String deviceId}) async {
    final url = normaliseServer(server);
    final client = ApiClient(baseUrl: url);
    try {
      final (t, g) = await client.join(code: code, deviceId: deviceId, name: name.trim());
      serverUrl = url;
      token = t;
      guest = g;
      user = null;
      orgs = const [];
    } finally {
      client.close();
    }
    final p = await _prefs;
    await p.setString(_kServer, serverUrl);
    await p.setString(_kToken, token!);
    await p.setString(_kGuest, jsonEncode(guest!.toJson()));
    await p.remove(_kUser);
    await p.remove(_kOrgs);
    notifyListeners();
  }

  void _adoptAccount(String url, AccountSession s) {
    serverUrl = url;
    token = s.token;
    user = s.user;
    orgs = s.orgs;
    guest = null;
    if (selectedOrgId == null || !orgs.any((o) => o.id == selectedOrgId)) {
      selectedOrgId = orgs.isEmpty ? null : orgs.first.id;
    }
  }

  Future<void> _saveAccount() async {
    final p = await _prefs;
    await p.setString(_kServer, serverUrl);
    if (token != null) await p.setString(_kToken, token!);
    if (user != null) await p.setString(_kUser, jsonEncode(user!.toJson()));
    await p.setString(_kOrgs, jsonEncode([for (final o in orgs) o.toJson()]));
    if (selectedOrgId != null) await p.setString(_kOrg, selectedOrgId!);
    await p.remove(_kGuest);
  }

  Future<void> selectOrg(String orgId) async {
    selectedOrgId = orgId;
    await (await _prefs).setString(_kOrg, orgId);
    notifyListeners();
  }

  /// After creating a new organisation.
  Future<void> addOrg(OrgMembership org) async {
    orgs = [...orgs, org];
    selectedOrgId = org.id;
    await _saveAccount();
    notifyListeners();
  }

  Future<void> signOut() async {
    await GoogleAuth.signOut();
    token = null;
    user = null;
    guest = null;
    orgs = const [];
    final p = await _prefs;
    await p.remove(_kToken);
    await p.remove(_kUser);
    await p.remove(_kOrgs);
    await p.remove(_kGuest);
    notifyListeners();
  }
}
