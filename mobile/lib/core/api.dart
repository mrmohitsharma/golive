import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'models.dart';

/// Error with the same shape on both platforms: a machine `code` plus a human `message`.
class ApiException implements Exception {
  ApiException(this.code, this.message, {this.status});
  final String code;
  final String message;
  final int? status;

  bool get isAuth => status == 401;
  bool get isNetwork => code == 'network' || code == 'timeout';

  @override
  String toString() => message;
}

/// Result of sign-in, sign-up and /api/me for an account.
class AccountSession {
  const AccountSession({required this.token, required this.user, required this.orgs});
  final String token;
  final AppUser user;
  final List<OrgMembership> orgs;
}

class ApiClient {
  ApiClient({required this.baseUrl, this.token, http.Client? client}) : _http = client ?? http.Client();

  final String baseUrl;
  String? token;
  final http.Client _http;

  Uri uri(String path) => Uri.parse(baseUrl.replaceAll(RegExp(r'/+$'), '') + path);

  /// Absolute URL for a server path ("/api/clips/…"); absolute URLs pass through.
  String absolute(String path) => path.startsWith('http') ? path : uri(path).toString();

  Map<String, String> get authHeaders => {if (token != null) 'Authorization': 'Bearer $token'};

  Future<Map<String, dynamic>> _send(String method, String path, [Object? body]) async {
    final req = http.Request(method, uri(path));
    req.headers.addAll(authHeaders);
    if (body != null) {
      req.headers['content-type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    http.StreamedResponse streamed;
    try {
      streamed = await _http.send(req).timeout(const Duration(seconds: 15));
    } on TimeoutException {
      throw ApiException('timeout', 'The server did not answer in time. Check the connection.');
    } on SocketException catch (e) {
      throw ApiException('network', 'Cannot reach the server (${e.osError?.message ?? e.message}).');
    } on HandshakeException {
      throw ApiException('tls', 'Secure connection to the server failed (certificate problem).');
    } on http.ClientException catch (e) {
      throw ApiException('network', 'Cannot reach the server (${e.message}).');
    }
    final res = await http.Response.fromStream(streamed);
    Map<String, dynamic> json = const {};
    if (res.body.isNotEmpty) {
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map<String, dynamic>) json = decoded;
      } on FormatException {
        // fall through to status handling
      }
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return json;
    final err = json['error'];
    if (err is Map) {
      throw ApiException('${err['code']}', '${err['message']}', status: res.statusCode);
    }
    throw ApiException('http_${res.statusCode}', 'Server error (${res.statusCode}).', status: res.statusCode);
  }

  Future<Map<String, dynamic>> get(String path) => _send('GET', path);
  Future<Map<String, dynamic>> post(String path, [Object? body]) => _send('POST', path, body ?? const {});
  Future<Map<String, dynamic>> patch(String path, Object body) => _send('PATCH', path, body);
  Future<Map<String, dynamic>> put(String path, Object body) => _send('PUT', path, body);
  Future<void> delete(String path) => _send('DELETE', path);

  /// Authenticated binary download (thumbnails, QR codes). Null if missing or unchanged (304).
  Future<(Uint8List?, String?)> bytes(String path, {String? etag, Duration timeout = const Duration(seconds: 10)}) async {
    final res = await _http
        .get(uri(path), headers: {...authHeaders, if (etag != null) 'If-None-Match': etag})
        .timeout(timeout);
    if (res.statusCode == 200) return (res.bodyBytes, res.headers['etag']);
    return (null, etag);
  }

  /// Kept for the multiview tiles.
  Future<(Uint8List?, String?)> thumbnail(String path, {String? etag}) => bytes(path, etag: etag, timeout: const Duration(seconds: 8));

  // ---------------------------------------------------------------- server & accounts
  Future<ServerInfo> info() async => ServerInfo.fromJson(await get('/api/info'));

  AccountSession _account(Map<String, dynamic> r) => AccountSession(
        token: r['token'] as String,
        user: AppUser.fromJson(r['user'] as Map<String, dynamic>),
        orgs: _orgs(r['orgs']),
      );

  static List<OrgMembership> _orgs(Object? list) =>
      ((list as List?) ?? const []).map((o) => OrgMembership.fromJson(o as Map<String, dynamic>)).toList();

  Future<AccountSession> login(String email, String password) async =>
      _account(await post('/api/auth/login', {'email': email, 'password': password}));

  Future<AccountSession> signup({required String name, required String email, required String password, required String orgName}) async =>
      _account(await post('/api/auth/signup', {'name': name, 'email': email, 'password': password, 'orgName': orgName}));

  /// Sign in with Google: the ID token from google_sign_in. Returns the session and whether
  /// the account is new (it then has no organisation yet; the app asks for its name).
  Future<(AccountSession, bool)> googleSignIn(String idToken, {String? orgName}) async {
    final r = await post('/api/auth/google', {'idToken': idToken, if (orgName != null && orgName.trim().length >= 2) 'orgName': orgName.trim()});
    return (_account(r), r['newUser'] == true);
  }

  /// Web-to-app handoff: the one-time code from the website's QR.
  Future<AccountSession> redeemHandoff(String code) async => _account(await post('/api/auth/handoff/redeem', {'code': code}));

  /// Volunteer join: no account, a token scoped to one tournament and role.
  Future<(String, GuestPass)> join({required String code, required String deviceId, required String name}) async {
    final r = await post('/api/join', {'code': code, 'deviceId': deviceId, 'name': name});
    final guest = r['guest'] as Map<String, dynamic>;
    return (
      r['token'] as String,
      GuestPass.fromJson({...guest, 'role': r['role'], 'tournament': {...(r['tournament'] as Map<String, dynamic>), 'role': r['role']}}),
    );
  }

  /// Who the token belongs to. For accounts: user + orgs. For guests: the tournament.
  Future<Map<String, dynamic>> me() => get('/api/me');

  // ---------------------------------------------------------------- organisations
  Future<List<OrgMembership>> orgs() async => _orgs((await get('/api/orgs'))['orgs']);

  Future<OrgMembership> createOrg(String name) async =>
      OrgMembership.fromJson((await post('/api/orgs', {'name': name}))['org'] as Map<String, dynamic>);

  Future<List<OrgMember>> members(String orgId) async => ((await get('/api/orgs/$orgId/members'))['members'] as List)
      .map((m) => OrgMember.fromJson(m as Map<String, dynamic>))
      .toList();

  /// Returns true when a new account was created (the owner must share the first password).
  Future<bool> addMember(String orgId, {required String email, required TournamentRole role, String? name, String? password}) async {
    final r = await post('/api/orgs/$orgId/members', {
      'email': email,
      'role': role.name,
      if (name != null && name.isNotEmpty) 'name': name,
      if (password != null && password.isNotEmpty) 'password': password,
    });
    return r['created'] == true;
  }

  Future<void> setMemberRole(String orgId, String userId, TournamentRole role) => patch('/api/orgs/$orgId/members/$userId', {'role': role.name});
  Future<void> removeMember(String orgId, String userId) => delete('/api/orgs/$orgId/members/$userId');

  Future<OrgYoutube> orgYoutube(String orgId) async => OrgYoutube.fromJson(await get('/api/orgs/$orgId/youtube'));
  Future<String> youtubeConnectUrl(String orgId) async => (await post('/api/orgs/$orgId/youtube/connect'))['url'] as String;
  Future<void> disconnectYoutube(String orgId) => delete('/api/orgs/$orgId/youtube');

  /// The main channel and any extra channels connected for more destinations.
  Future<List<YoutubeChannel>> youtubeChannels(String orgId) async =>
      (((await get('/api/orgs/$orgId/youtube/channels'))['channels'] as List?) ?? const [])
          .map((c) => YoutubeChannel.fromJson(c as Map<String, dynamic>))
          .toList();
  Future<String> youtubeChannelConnectUrl(String orgId) async =>
      (await post('/api/orgs/$orgId/youtube/channels/connect'))['url'] as String;
  Future<void> disconnectYoutubeChannel(String orgId, String channelId) => delete('/api/orgs/$orgId/youtube/channels/$channelId');

  Future<OrgFacebook> orgFacebook(String orgId) async => OrgFacebook.fromJson(await get('/api/orgs/$orgId/facebook'));
  Future<String> facebookConnectUrl(String orgId) async => (await post('/api/orgs/$orgId/facebook/connect'))['url'] as String;
  Future<OrgFacebook> selectFacebookPage(String orgId, String pageId) async =>
      OrgFacebook.fromJson(await put('/api/orgs/$orgId/facebook/page', {'pageId': pageId}));
  Future<void> disconnectFacebook(String orgId) => delete('/api/orgs/$orgId/facebook');

  // ---------------------------------------------------------------- billing
  Future<OrgBilling> orgBilling(String orgId) async => OrgBilling.fromJson(await get('/api/orgs/$orgId/billing'));

  Future<BillingDetails> saveBillingDetails(String orgId, {String? name, String? phone, String? email, String? gstin}) async =>
      BillingDetails.fromJson((await put('/api/orgs/$orgId/billing/details', {
        'name': (name ?? '').trim().isEmpty ? null : name!.trim(),
        'phone': (phone ?? '').trim().isEmpty ? null : phone!.trim(),
        'email': (email ?? '').trim().isEmpty ? null : email!.trim(),
        'gstin': (gstin ?? '').trim().isEmpty ? null : gstin!.trim(),
      }))['details'] as Map<String, dynamic>);

  /// Starts a credit purchase; open `checkoutUrl` in the browser (Cashfree).
  Future<(PaymentInfo, String)> checkout(String orgId, String packId, {String? phone}) async {
    final r = await post('/api/orgs/$orgId/billing/checkout', {'packId': packId, if (phone != null && phone.isNotEmpty) 'phone': phone});
    return (PaymentInfo.fromJson(r['payment'] as Map<String, dynamic>), r['checkoutUrl'] as String);
  }

  Future<(PaymentInfo, double)> payment(String id) async {
    final r = await get('/api/payments/$id');
    return (PaymentInfo.fromJson(r['payment'] as Map<String, dynamic>), ((r['balance'] as num?) ?? 0).toDouble());
  }

  Future<TournamentBilling> tournamentBilling(String id) async =>
      TournamentBilling.fromJson((await get('/api/tournaments/$id/billing'))['billing'] as Map<String, dynamic>?);

  Future<TournamentBilling> buyDestinations(String id, int count) async =>
      TournamentBilling.fromJson((await post('/api/tournaments/$id/billing/destinations', {'count': count}))['billing'] as Map<String, dynamic>?);

  Future<TournamentBilling> buyCameras(String id, int count) async =>
      TournamentBilling.fromJson((await post('/api/tournaments/$id/billing/cameras', {'count': count}))['billing'] as Map<String, dynamic>?);

  // ---------------------------------------------------------------- tournaments
  Future<List<Tournament>> tournaments() async => ((await get('/api/tournaments'))['tournaments'] as List)
      .map((t) => Tournament.fromJson(t as Map<String, dynamic>))
      .toList();

  Future<Tournament> createTournament(String orgId, {required String name, String? venue, String? startsOn, ProductionMode? mode}) async =>
      Tournament.fromJson((await post('/api/orgs/$orgId/tournaments', {
        'name': name,
        if (venue != null && venue.isNotEmpty) 'venue': venue,
        if (startsOn != null) 'startsOn': startsOn,
        if (mode != null) 'mode': mode.name,
      }))['tournament'] as Map<String, dynamic>);

  Future<Tournament> updateTournament(
    String id, {
    String? name,
    String? venue,
    bool? autoFallback,
    bool? archived,
    ProductionMode? mode,
    bool? publicWatch,
    bool? chatEnabled,
    int? chatSlowSec,
  }) async =>
      Tournament.fromJson((await patch('/api/tournaments/$id', {
        if (name != null) 'name': name,
        if (venue != null) 'venue': venue,
        if (autoFallback != null) 'autoFallback': autoFallback,
        if (archived != null) 'archived': archived,
        if (mode != null) 'mode': mode.name,
        if (publicWatch != null) 'publicWatch': publicWatch,
        if (chatEnabled != null) 'chatEnabled': chatEnabled,
        if (chatSlowSec != null) 'chatSlowSec': chatSlowSec,
      }))['tournament'] as Map<String, dynamic>);

  // ---------------------------------------------------------------- viewer comments
  /// Combined feed (watch page + YouTube + Facebook). Null = unchanged since [version].
  Future<ChatFeed?> chatFeed(String tournamentId, {int? version}) async =>
      ChatFeed.fromJson(await get('/api/tournaments/$tournamentId/chat${version != null ? '?v=$version' : ''}'));

  Future<void> updateChatMessage(int id, {bool? answered, bool? hidden, bool? pinned}) => patch('/api/chat/$id', {
        if (answered != null) 'answered': answered,
        if (hidden != null) 'hidden': hidden,
        if (pinned != null) 'pinned': pinned,
      });

  Future<void> blockChatAuthor(int id) => post('/api/chat/$id/ban');

  /// Shows (or removes) the "Viewer question" graphic on the broadcast.
  Future<void> chatOnAir(int id, {bool visible = true}) => post('/api/chat/$id/on-air', {'visible': visible});

  Future<Tournament> setAutoFallback(String tournamentId, bool on) => updateTournament(tournamentId, autoFallback: on);

  /// Same content as the WebSocket snapshot (managers get production, YouTube, audio…).
  Future<Map<String, dynamic>> tournamentState(String id) => get('/api/tournaments/$id/state');

  /// The event's camera, scorer and commentator invites (created by the server if missing).
  Future<List<Invite>> invites(String id) async => ((await get('/api/tournaments/$id/invites'))['invites'] as List)
      .map((c) => Invite.fromJson(c as Map<String, dynamic>))
      .toList();

  Future<List<JoinCode>> joinCodes(String id) async => ((await get('/api/tournaments/$id/join-codes'))['codes'] as List)
      .map((c) => JoinCode.fromJson(c as Map<String, dynamic>))
      .toList();

  Future<JoinCode> createJoinCode(String id, TournamentRole role, {String? label, int? expiresInHours}) async =>
      JoinCode.fromJson((await post('/api/tournaments/$id/join-codes', {
        'role': role.name,
        if (label != null && label.isNotEmpty) 'label': label,
        if (expiresInHours != null) 'expiresInHours': expiresInHours,
      }))['code'] as Map<String, dynamic>);

  Future<void> revokeJoinCode(String id, String code) => delete('/api/tournaments/$id/join-codes/$code');

  Future<EngineSetup> engineSetup(String id) async => EngineSetup.fromJson(await get('/api/tournaments/$id/engine-setup'));
  Future<String> rotateEngineKey(String id) async => (await post('/api/tournaments/$id/engine-key/rotate'))['engineKey'] as String;

  Future<YoutubeState> createBroadcast(String id, {String? title, String privacy = 'unlisted'}) async {
    final r = await post('/api/tournaments/$id/youtube/broadcast', {if (title != null && title.isNotEmpty) 'title': title, 'privacy': privacy});
    return YoutubeState.fromJson(r['youtube'] as Map<String, dynamic>?);
  }

  Future<void> forgetBroadcast(String id) => delete('/api/tournaments/$id/youtube/broadcast');

  /// A stream key pasted from YouTube Studio (and optionally the video link, for the watch page).
  Future<YoutubeState> setYoutubeKey(String id, {String? streamKey, String? videoUrl}) async => YoutubeState.fromJson((await put('/api/tournaments/$id/youtube/key', {
        if (streamKey != null) 'streamKey': streamKey,
        if (videoUrl != null) 'videoUrl': videoUrl.isEmpty ? null : videoUrl,
      }))['youtube'] as Map<String, dynamic>?);

  Future<YoutubeState> clearYoutubeKey(String id) async =>
      YoutubeState.fromJson((await _send('DELETE', '/api/tournaments/$id/youtube/key'))['youtube'] as Map<String, dynamic>?);

  /// The organisation's channel or the Go Live channel (a pasted key: [setYoutubeKey]).
  Future<YoutubeState> setYoutubeSource(String id, YoutubeSource source) async =>
      YoutubeState.fromJson((await put('/api/tournaments/$id/youtube/source', {'source': source.name}))['youtube'] as Map<String, dynamic>?);

  Future<OutputsState> outputs(String id) async => OutputsState.fromJson((await get('/api/tournaments/$id/outputs'))['outputs'] as Map<String, dynamic>?);

  /// Turn platforms on/off; Instagram: paste the stream URL and key from instagram.com (they change every stream).
  /// Extra destinations: {'kind': 'channel', 'channelId', 'privacy'} or {'kind': 'key', 'platform', 'streamUrl', 'streamKey', 'label'}.
  Future<(OutputsState, TournamentBilling)> addDestination(String id, Map<String, Object?> body) async => _destinations(await post('/api/tournaments/$id/destinations', body));
  Future<(OutputsState, TournamentBilling)> updateDestination(String id, String destId, Map<String, Object?> body) async =>
      _destinations(await patch('/api/tournaments/$id/destinations/$destId', body));
  Future<(OutputsState, TournamentBilling)> removeDestination(String id, String destId) async =>
      _destinations(await _send('DELETE', '/api/tournaments/$id/destinations/$destId'));
  (OutputsState, TournamentBilling) _destinations(Map<String, dynamic> r) => (
        OutputsState.fromJson(r['outputs'] as Map<String, dynamic>?),
        TournamentBilling.fromJson(r['billing'] as Map<String, dynamic>?),
      );

  Future<OutputsState> setOutputs(String id, Map<String, Object?> patch_) async =>
      OutputsState.fromJson((await patch('/api/tournaments/$id/outputs', patch_))['outputs'] as Map<String, dynamic>?);

  Future<ProductionState> startCloudEngine(String id) async =>
      ProductionState.fromJson((await post('/api/tournaments/$id/cloud-engine/start'))['production'] as Map<String, dynamic>?);

  Future<ProductionState> stopCloudEngine(String id, {bool force = false}) async => ProductionState.fromJson(
      (await post('/api/tournaments/$id/cloud-engine/stop${force ? '?force=true' : ''}'))['production'] as Map<String, dynamic>?);

  Future<AudioState> setAudio(String id, Map<String, Object?> patch_) async =>
      AudioState.fromJson((await patch('/api/tournaments/$id/audio', patch_))['audio'] as Map<String, dynamic>?);

  Future<GraphicsState> setGraphics(String id, Map<String, Object?> patch_) async =>
      GraphicsState.fromJson((await patch('/api/tournaments/$id/graphics', patch_))['graphics'] as Map<String, dynamic>?);

  // ---------------------------------------------------------------- cameras
  Future<(CameraInfo, PublishTarget)> registerCamera({
    required String tournamentId,
    required String name,
    int? hole,
    String? position,
    required String deviceId,
    required String platform,
    String? deviceModel,
  }) async {
    final r = await post('/api/tournaments/$tournamentId/cameras/register', {
      'name': name,
      'hole': hole,
      'position': position,
      'deviceId': deviceId,
      'platform': platform,
      'deviceModel': deviceModel,
    });
    return (
      CameraInfo.fromJson(r['camera'] as Map<String, dynamic>),
      PublishTarget.fromJson(r['publish'] as Map<String, dynamic>),
    );
  }

  Future<PublishTarget> publishTarget(String cameraId) async => PublishTarget.fromJson(await get('/api/cameras/$cameraId/publish'));

  Future<CameraInfo> updateCamera(String cameraId, {String? name, int? hole, bool clearHole = false, String? position}) async {
    final body = <String, dynamic>{
      if (name != null) 'name': name,
      if (hole != null || clearHole) 'hole': hole,
      if (position != null) 'position': position,
    };
    return CameraInfo.fromJson((await patch('/api/cameras/$cameraId', body))['camera'] as Map<String, dynamic>);
  }

  Future<void> removeCamera(String cameraId) => delete('/api/cameras/$cameraId');

  Future<CommentaryTarget> registerCommentator(String tournamentId, {required String name, required String deviceId}) async =>
      CommentaryTarget.fromJson(await post('/api/tournaments/$tournamentId/commentators/register', {'name': name, 'deviceId': deviceId}));

  // ---------------------------------------------------------------- scoring
  Future<List<Hole>> holes(String id) async =>
      ((await get('/api/tournaments/$id/holes'))['holes'] as List).map((h) => Hole.fromJson(h as Map<String, dynamic>)).toList();

  Future<List<Hole>> setPar72(String id) async =>
      ((await put('/api/tournaments/$id/holes', {'preset': 'par72'}))['holes'] as List).map((h) => Hole.fromJson(h as Map<String, dynamic>)).toList();

  Future<List<Hole>> setHoles(String id, List<Hole> holes) async => ((await put('/api/tournaments/$id/holes', {
        'holes': [for (final h in holes) {'number': h.number, 'par': h.par, if (h.yardage != null) 'yardage': h.yardage}],
      }))['holes'] as List)
          .map((h) => Hole.fromJson(h as Map<String, dynamic>))
          .toList();

  Future<List<Player>> players(String id) async =>
      ((await get('/api/tournaments/$id/players'))['players'] as List).map((p) => Player.fromJson(p as Map<String, dynamic>)).toList();

  /// Paste "Name, Club, Category, Group" lines (e.g. copied from a spreadsheet).
  Future<List<Player>> importPlayers(String id, String csv) async =>
      ((await post('/api/tournaments/$id/players', {'csv': csv}))['players'] as List).map((p) => Player.fromJson(p as Map<String, dynamic>)).toList();

  Future<void> deletePlayer(String playerId) => delete('/api/players/$playerId');

  /// Enter (or clear with null) one player's strokes on one hole.
  Future<LeaderboardRow?> setScore(String tournamentId, {required String playerId, required int hole, required int? strokes}) async {
    final r = await put('/api/tournaments/$tournamentId/scores', {'playerId': playerId, 'hole': hole, 'strokes': strokes});
    final p = r['player'];
    return p is Map<String, dynamic> ? LeaderboardRow.fromJson(p) : null;
  }

  Future<List<LeaderboardRow>> leaderboard(String id) async => parseLeaderboard((await get('/api/tournaments/$id/leaderboard'))['rows']);

  // ---------------------------------------------------------------- clips
  Future<HighlightClip> createClip(String tournamentId, {required String cameraId, int secondsBack = 30, int durationSec = 30, String? title}) async =>
      HighlightClip.fromJson((await post('/api/tournaments/$tournamentId/clips', {
        'cameraId': cameraId,
        'secondsBack': secondsBack,
        'durationSec': durationSec,
        if (title != null && title.isNotEmpty) 'title': title,
      }))['clip'] as Map<String, dynamic>);

  Future<List<HighlightClip>> clips(String tournamentId) async =>
      ((await get('/api/tournaments/$tournamentId/clips'))['clips'] as List).map((c) => HighlightClip.fromJson(c as Map<String, dynamic>)).toList();

  Future<ClipLinks> shareClip(String clipId) async => ClipLinks.fromJson(await post('/api/clips/$clipId/share'));
  Future<void> deleteClip(String clipId) => delete('/api/clips/$clipId');

  Future<HighlightClip> setClipPublic(String clipId, bool isPublic) async =>
      HighlightClip.fromJson((await patch('/api/clips/$clipId', {'public': isPublic}))['clip'] as Map<String, dynamic>);

  void close() => _http.close();
}
