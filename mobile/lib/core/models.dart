// Data models shared by every screen. They mirror the server's JSON (server/src/protocol.ts,
// routes/*.ts and docs/PROTOCOL.md) so Android and iOS behave identically.

// ---------------------------------------------------------------- identity

/// Role inside an organisation, and therefore inside each of its tournaments.
/// Volunteers who join with a code get camera / scorer / commentator for one tournament.
enum TournamentRole { owner, director, scorer, commentator, camera, engine }

TournamentRole? parseRole(String? s) {
  for (final r in TournamentRole.values) {
    if (r.name == s) return r;
  }
  return null;
}

extension TournamentRoleX on TournamentRole {
  bool get canDirect => this == TournamentRole.owner || this == TournamentRole.director;
  bool get canManage => canDirect;
  bool get canScore => canDirect || this == TournamentRole.scorer;
  bool get canCommentate => canDirect || this == TournamentRole.commentator;
  bool get canCamera => canDirect || this == TournamentRole.camera;
  bool get canWatch => canDirect || this == TournamentRole.commentator;

  String get label => switch (this) {
        TournamentRole.owner => 'Owner',
        TournamentRole.director => 'Director',
        TournamentRole.scorer => 'Scorer',
        TournamentRole.commentator => 'Commentator',
        TournamentRole.camera => 'Camera operator',
        TournamentRole.engine => 'Broadcast engine',
      };
}

/// Roles an owner can give staff in the organisation.
const orgRoles = [TournamentRole.owner, TournamentRole.director, TournamentRole.scorer, TournamentRole.commentator, TournamentRole.camera];

/// Roles a join code (QR poster) can hand out.
const guestRoles = [TournamentRole.camera, TournamentRole.scorer, TournamentRole.commentator];

class AppUser {
  const AppUser({required this.id, required this.email, required this.name, this.platformAdmin = false});

  final String id;
  final String email;
  final String name;
  final bool platformAdmin;

  factory AppUser.fromJson(Map<String, dynamic> j) => AppUser(
        id: j['id'] as String,
        email: (j['email'] as String?) ?? '',
        name: (j['name'] as String?) ?? '',
        platformAdmin: (j['platformAdmin'] as bool?) ?? false,
      );

  Map<String, dynamic> toJson() => {'id': id, 'email': email, 'name': name, 'platformAdmin': platformAdmin};
}

class OrgMembership {
  const OrgMembership({required this.id, required this.name, required this.role});
  final String id;
  final String name;
  final TournamentRole role;

  bool get isOwner => role == TournamentRole.owner;
  bool get canCreateTournaments => role == TournamentRole.owner || role == TournamentRole.director;

  factory OrgMembership.fromJson(Map<String, dynamic> j) => OrgMembership(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        role: parseRole(j['role'] as String?) ?? TournamentRole.camera,
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'role': role.name};
}

class OrgMember {
  const OrgMember({required this.userId, required this.email, required this.name, required this.role});
  final String userId;
  final String email;
  final String name;
  final TournamentRole role;

  factory OrgMember.fromJson(Map<String, dynamic> j) => OrgMember(
        userId: j['userId'] as String,
        email: (j['email'] as String?) ?? '',
        name: (j['name'] as String?) ?? '',
        role: parseRole(j['role'] as String?) ?? TournamentRole.camera,
      );
}

/// A volunteer who joined one tournament with a code (no account).
class GuestPass {
  const GuestPass({required this.id, required this.name, required this.role, required this.tournament});
  final String id;
  final String name;
  final TournamentRole role;
  final Tournament tournament;

  factory GuestPass.fromJson(Map<String, dynamic> j) => GuestPass(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        role: parseRole(j['role'] as String?) ?? TournamentRole.camera,
        tournament: Tournament.fromJson(j['tournament'] as Map<String, dynamic>),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'role': role.name,
        'tournament': {'id': tournament.id, 'name': tournament.name, 'venue': tournament.venue, 'role': role.name, 'profile': tournament.profile.toJson()},
      };
}

class ServerInfo {
  const ServerInfo({
    this.signup = false,
    this.youtube = false,
    this.facebook = false,
    this.cloudProduction = false,
    this.cloudCostPerHour = 0,
    this.billing = false,
    this.payments = false,
    this.goliveChannel = false,
  });
  final bool signup;

  /// Events can stream to the platform's Go Live YouTube channel (nothing to connect).
  final bool goliveChannel;
  /// Camera and live-minute limits with a credit wallet.
  final bool billing;
  /// Credits can be bought online (Cashfree).
  final bool payments;
  final bool youtube;
  final bool facebook;
  final bool cloudProduction;
  final double cloudCostPerHour;

  factory ServerInfo.fromJson(Map<String, dynamic> j) => ServerInfo(
        signup: (j['signup'] as bool?) ?? false,
        youtube: (j['youtube'] as bool?) ?? false,
        facebook: (j['facebook'] as bool?) ?? false,
        cloudProduction: (j['cloudProduction'] as bool?) ?? false,
        cloudCostPerHour: (j['cloudCostPerHour'] as num?)?.toDouble() ?? 0,
        goliveChannel: (j['goliveChannel'] as bool?) ?? false,
        billing: (j['billing'] as bool?) ?? false,
        payments: (j['payments'] as bool?) ?? false,
      );
}

// ---------------------------------------------------------------- tournaments

enum ProductionMode { laptop, cloud }

/// The kind of event and what it changes in the app (labels, golf-only features).
class EventProfile {
  const EventProfile({
    this.id = 'golf',
    this.label = 'Golf',
    this.positionLabel = 'Hole',
    this.scoring = true,
    this.captionTitle = 'Player',
    this.captionSubtitle = 'Club or score',
    this.captionExample = '',
  });

  final String id;
  final String label;

  /// Asked in camera setup (golf: the hole); null = not asked.
  final String? positionLabel;

  /// Golf scoring, hole cards, leaderboard.
  final bool scoring;
  final String captionTitle;
  final String captionSubtitle;
  final String captionExample;

  bool get isGolf => id == 'golf';

  factory EventProfile.fromJson(Map<String, dynamic>? j) => j == null
      ? const EventProfile()
      : EventProfile(
          id: (j['id'] as String?) ?? 'golf',
          label: (j['label'] as String?) ?? 'Golf',
          positionLabel: j['positionLabel'] as String?,
          scoring: (j['scoring'] as bool?) ?? false,
          captionTitle: (j['captionTitle'] as String?) ?? 'Name',
          captionSubtitle: (j['captionSubtitle'] as String?) ?? 'Details',
          captionExample: (j['captionExample'] as String?) ?? '',
        );

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'positionLabel': positionLabel,
        'scoring': scoring,
        'captionTitle': captionTitle,
        'captionSubtitle': captionSubtitle,
        'captionExample': captionExample,
      };
}

class Tournament {
  const Tournament({
    required this.id,
    required this.name,
    this.venue,
    this.orgId,
    this.orgName,
    this.startsOn,
    this.mode = ProductionMode.laptop,
    this.autoFallback = true,
    this.archived = false,
    this.hasYoutubeBroadcast = false,
    this.publicWatch = true,
    this.chatEnabled = true,
    this.chatSlowSec = 3,
    this.role,
    this.profile = const EventProfile(),
  });

  final String id;
  final String name;

  /// Kind of event (golf, wedding, conference…) and its labels.
  final EventProfile profile;
  final String? venue;
  final String? orgId;
  final String? orgName;
  final String? startsOn;
  final ProductionMode mode;
  final bool autoFallback;
  final bool archived;
  final bool hasYoutubeBroadcast;

  /// Listed on the public watch page (and its API for the CoGolfers website).
  final bool publicWatch;

  /// Viewers can post in the watch-page chat; seconds between two messages from one viewer.
  final bool chatEnabled;
  final int chatSlowSec;

  /// The caller's role in this tournament (from GET /api/tournaments).
  final TournamentRole? role;

  String get title => venue == null || venue!.isEmpty ? name : '$name · $venue';

  factory Tournament.fromJson(Map<String, dynamic> j) => Tournament(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        venue: j['venue'] as String?,
        orgId: j['orgId'] as String?,
        orgName: j['orgName'] as String?,
        startsOn: j['startsOn'] as String?,
        mode: j['mode'] == 'cloud' ? ProductionMode.cloud : ProductionMode.laptop,
        autoFallback: (j['autoFallback'] as bool?) ?? true,
        archived: (j['archived'] as bool?) ?? false,
        hasYoutubeBroadcast: (j['hasYoutubeBroadcast'] as bool?) ?? false,
        publicWatch: (j['publicWatch'] as bool?) ?? true,
        chatEnabled: (j['chatEnabled'] as bool?) ?? true,
        chatSlowSec: (j['chatSlowSec'] as num?)?.toInt() ?? 3,
        role: parseRole(j['role'] as String?),
        profile: EventProfile.fromJson(j['profile'] as Map<String, dynamic>?),
      );

  Tournament copyWith({TournamentRole? role}) => Tournament(
        id: id,
        name: name,
        venue: venue,
        orgId: orgId,
        orgName: orgName,
        startsOn: startsOn,
        mode: mode,
        autoFallback: autoFallback,
        archived: archived,
        hasYoutubeBroadcast: hasYoutubeBroadcast,
        publicWatch: publicWatch,
        chatEnabled: chatEnabled,
        chatSlowSec: chatSlowSec,
        role: role ?? this.role,
        profile: profile,
      );
}

class JoinCode {
  const JoinCode({required this.code, required this.role, this.label, this.uses = 0, this.expiresAt, required this.joinUrl, required this.qrUrl});
  final String code;
  final TournamentRole role;
  final String? label;
  final int uses;
  final DateTime? expiresAt;
  final String joinUrl;
  final String qrUrl;

  /// "ABC123" -> "ABC-123", easier to read out over a radio.
  String get display => code.length == 6 ? '${code.substring(0, 3)}-${code.substring(3)}' : code;

  factory JoinCode.fromJson(Map<String, dynamic> j) => JoinCode(
        code: j['code'] as String,
        role: parseRole(j['role'] as String?) ?? TournamentRole.camera,
        label: j['label'] as String?,
        uses: (j['uses'] as num?)?.toInt() ?? 0,
        expiresAt: j['expiresAt'] == null ? null : DateTime.tryParse('${j['expiresAt']}'),
        joinUrl: j['joinUrl'] as String,
        qrUrl: j['qrUrl'] as String,
      );
}

/// A standing invite of an event (made automatically, one per role) with ready-made share links.
class Invite {
  const Invite({required this.code, required this.shareText, required this.whatsapp});
  final JoinCode code;
  final String shareText;
  final String whatsapp;

  TournamentRole get role => code.role;

  factory Invite.fromJson(Map<String, dynamic> j) => Invite(
        code: JoinCode.fromJson(j),
        shareText: (j['shareText'] as String?) ?? j['joinUrl'] as String,
        whatsapp: (j['whatsapp'] as String?) ?? 'https://wa.me/?text=${Uri.encodeComponent(j['joinUrl'] as String)}',
      );
}

class EngineSetup {
  const EngineSetup({required this.tournamentId, required this.engineKey, required this.serverUrl, required this.envFile});
  final String tournamentId;
  final String engineKey;
  final String serverUrl;
  final String envFile;

  factory EngineSetup.fromJson(Map<String, dynamic> j) => EngineSetup(
        tournamentId: j['tournamentId'] as String,
        engineKey: j['engineKey'] as String,
        serverUrl: j['serverUrl'] as String,
        envFile: j['envFile'] as String,
      );
}

// ---------------------------------------------------------------- cameras

/// Server-side view of a feed, measured at the ingest server (MediaMTX).
class CameraHealth {
  const CameraHealth({this.online = false, this.inboundKbps = 0, this.readers = 0, this.tracks = const []});

  final bool online;
  final int inboundKbps;
  final int readers;
  final List<String> tracks;

  factory CameraHealth.fromJson(Map<String, dynamic>? j) => j == null
      ? const CameraHealth()
      : CameraHealth(
          online: (j['online'] as bool?) ?? false,
          inboundKbps: (j['inboundKbps'] as num?)?.round() ?? 0,
          readers: (j['readers'] as num?)?.round() ?? 0,
          tracks: ((j['tracks'] as List?) ?? const []).map((e) => '$e').toList(),
        );
}

/// What the phone itself reports (battery, upload bitrate, app state).
class CameraTelemetry {
  const CameraTelemetry({
    this.state = 'idle',
    this.bitrateKbps,
    this.battery,
    this.charging,
    this.durationSec,
    this.appState,
    this.resolution,
    this.fps,
    this.thermal,
    this.error,
  });

  final String state;
  final int? bitrateKbps;
  final int? battery;
  final bool? charging;
  final int? durationSec;
  final String? appState;
  final String? resolution;
  final int? fps;
  final String? thermal;
  final String? error;

  static CameraTelemetry? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : CameraTelemetry(
          state: (j['state'] as String?) ?? 'idle',
          bitrateKbps: (j['bitrateKbps'] as num?)?.round(),
          battery: (j['battery'] as num?)?.round(),
          charging: j['charging'] as bool?,
          durationSec: (j['durationSec'] as num?)?.round(),
          appState: j['appState'] as String?,
          resolution: j['resolution'] as String?,
          fps: (j['fps'] as num?)?.round(),
          thermal: j['thermal'] as String?,
          error: j['error'] as String?,
        );

  Map<String, dynamic> toJson() => {
        'state': state,
        if (bitrateKbps != null) 'bitrateKbps': bitrateKbps,
        if (battery != null) 'battery': battery,
        if (charging != null) 'charging': charging,
        if (durationSec != null) 'durationSec': durationSec,
        if (appState != null) 'appState': appState,
        if (resolution != null) 'resolution': resolution,
        if (fps != null) 'fps': fps,
        if (thermal != null) 'thermal': thermal,
        if (error != null) 'error': error,
      };
}

enum FeedStatus { live, connecting, paused, offline }

class CameraInfo {
  const CameraInfo({
    required this.id,
    required this.tournamentId,
    required this.name,
    this.hole,
    this.position,
    required this.streamPath,
    this.platform,
    this.deviceModel,
    this.status = FeedStatus.offline,
    this.health = const CameraHealth(),
    this.telemetry,
    this.onAir = false,
    this.inPreview = false,
    required this.whepUrl,
    required this.thumbnailUrl,
  });

  final String id;
  final String tournamentId;
  final String name;
  final int? hole;
  final String? position;
  final String streamPath;
  final String? platform;
  final String? deviceModel;
  final FeedStatus status;
  final CameraHealth health;
  final CameraTelemetry? telemetry;
  final bool onAir;
  final bool inPreview;
  final String whepUrl;
  final String thumbnailUrl;

  String get assignment {
    final parts = <String>[
      if (hole != null) 'Hole $hole',
      if (position != null && position!.isNotEmpty) position!,
    ];
    return parts.isEmpty ? 'Unassigned' : parts.join(' · ');
  }

  factory CameraInfo.fromJson(Map<String, dynamic> j) => CameraInfo(
        id: j['id'] as String,
        tournamentId: j['tournamentId'] as String,
        name: j['name'] as String,
        hole: (j['hole'] as num?)?.toInt(),
        position: j['position'] as String?,
        streamPath: j['streamPath'] as String,
        platform: j['platform'] as String?,
        deviceModel: j['deviceModel'] as String?,
        status: FeedStatus.values.firstWhere((s) => s.name == j['status'], orElse: () => FeedStatus.offline),
        health: CameraHealth.fromJson(j['health'] as Map<String, dynamic>?),
        telemetry: CameraTelemetry.fromJson(j['telemetry'] as Map<String, dynamic>?),
        onAir: (j['onAir'] as bool?) ?? false,
        inPreview: (j['inPreview'] as bool?) ?? false,
        whepUrl: j['whepUrl'] as String,
        thumbnailUrl: j['thumbnailUrl'] as String,
      );
}

class PublishTarget {
  const PublishTarget({required this.srtUrl, required this.latencyMs});
  final String srtUrl;
  final int latencyMs;

  factory PublishTarget.fromJson(Map<String, dynamic> j) =>
      PublishTarget(srtUrl: j['srtUrl'] as String, latencyMs: (j['latencyMs'] as num?)?.toInt() ?? 600);
}

// ---------------------------------------------------------------- commentary

class Commentator {
  const Commentator({required this.id, required this.name, required this.streamPath, this.online = false, this.inboundKbps = 0});
  final String id;
  final String name;
  final String streamPath;
  final bool online;
  final int inboundKbps;

  /// OBS input name the agent creates for this commentator (meters are keyed by it).
  String get obsInput => 'CG Commentary $streamPath';

  factory Commentator.fromJson(Map<String, dynamic> j) => Commentator(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        streamPath: j['streamPath'] as String,
        online: (j['online'] as bool?) ?? false,
        inboundKbps: (j['inboundKbps'] as num?)?.round() ?? 0,
      );
}

/// Where a commentator's phone sends its microphone (WebRTC WHIP to MediaMTX).
class CommentaryTarget {
  const CommentaryTarget({required this.commentator, required this.whipUrl, required this.bearer});
  final Commentator commentator;
  final String whipUrl;
  final String bearer;

  factory CommentaryTarget.fromJson(Map<String, dynamic> j) {
    final p = j['publish'] as Map<String, dynamic>;
    return CommentaryTarget(
      commentator: Commentator.fromJson(j['commentator'] as Map<String, dynamic>),
      whipUrl: p['whipUrl'] as String,
      bearer: p['bearer'] as String,
    );
  }
}

// ---------------------------------------------------------------- engine / production

class StreamOutputStatus {
  const StreamOutputStatus({this.active = false, this.reconnecting = false, this.timecode, this.kbps, this.congestion, this.skippedFrames, this.totalFrames});

  final bool active;
  final bool reconnecting;
  final String? timecode;
  final int? kbps;
  final double? congestion;
  final int? skippedFrames;
  final int? totalFrames;

  factory StreamOutputStatus.fromJson(Map<String, dynamic>? j) => j == null
      ? const StreamOutputStatus()
      : StreamOutputStatus(
          active: (j['active'] as bool?) ?? false,
          reconnecting: (j['reconnecting'] as bool?) ?? false,
          timecode: j['timecode'] as String?,
          kbps: (j['kbps'] as num?)?.round(),
          congestion: (j['congestion'] as num?)?.toDouble(),
          skippedFrames: (j['skippedFrames'] as num?)?.round(),
          totalFrames: (j['totalFrames'] as num?)?.round(),
        );
}

/// Broadcast engine (OBS) state. `programmeCameraId` is what OBS confirmed is on air.
class EngineState {
  const EngineState({
    this.connected = false,
    this.obsConnected = false,
    this.obsVersion,
    this.programmeCameraId,
    this.previewCameraId,
    this.programmeScene,
    this.fallbackActive = false,
    this.replayActive = false,
    this.studioMode = false,
    this.streaming = const StreamOutputStatus(),
    this.warnings = const [],
    this.lastError,
  });

  final bool connected;
  final bool obsConnected;
  final String? obsVersion;
  final String? programmeCameraId;
  final String? previewCameraId;
  final String? programmeScene;
  final bool fallbackActive;
  final bool replayActive;
  final bool studioMode;
  final StreamOutputStatus streaming;
  final List<String> warnings;
  final String? lastError;

  bool get canSwitch => connected && obsConnected;

  factory EngineState.fromJson(Map<String, dynamic>? j) => j == null
      ? const EngineState()
      : EngineState(
          connected: (j['connected'] as bool?) ?? false,
          obsConnected: (j['obsConnected'] as bool?) ?? false,
          obsVersion: j['obsVersion'] as String?,
          programmeCameraId: j['programmeCameraId'] as String?,
          previewCameraId: j['previewCameraId'] as String?,
          programmeScene: j['programmeScene'] as String?,
          fallbackActive: (j['fallbackActive'] as bool?) ?? false,
          replayActive: (j['replayActive'] as bool?) ?? false,
          studioMode: (j['studioMode'] as bool?) ?? false,
          streaming: StreamOutputStatus.fromJson(j['streaming'] as Map<String, dynamic>?),
          warnings: ((j['warnings'] as List?) ?? const []).map((e) => '$e').toList(),
          lastError: j['lastError'] as String?,
        );
}

enum CloudEngineStatus { stopped, starting, running, stopping, error }

class ProductionState {
  const ProductionState({
    this.mode = ProductionMode.laptop,
    this.cloudAvailable = false,
    this.cloudStatus = CloudEngineStatus.stopped,
    this.startedAt,
    this.error,
    this.costPerHour = 0,
    this.autoStopAfterIdleMin = 0,
  });

  final ProductionMode mode;
  final bool cloudAvailable;
  final CloudEngineStatus cloudStatus;
  final DateTime? startedAt;
  final String? error;
  final double costPerHour;
  final int autoStopAfterIdleMin;

  bool get cloudBusy => cloudStatus == CloudEngineStatus.starting || cloudStatus == CloudEngineStatus.stopping;

  /// Running cost so far, for the organiser (server-configured hourly rate).
  double costSoFar(DateTime now) {
    if (startedAt == null || cloudStatus == CloudEngineStatus.stopped) return 0;
    final hours = now.difference(startedAt!).inSeconds / 3600;
    return hours < 0 ? 0 : hours * costPerHour;
  }

  factory ProductionState.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const ProductionState();
    final c = (j['cloud'] as Map<String, dynamic>?) ?? const {};
    return ProductionState(
      mode: j['mode'] == 'cloud' ? ProductionMode.cloud : ProductionMode.laptop,
      cloudAvailable: (j['cloudAvailable'] as bool?) ?? false,
      cloudStatus: CloudEngineStatus.values.firstWhere((s) => s.name == c['status'], orElse: () => CloudEngineStatus.stopped),
      startedAt: c['startedAt'] == null ? null : DateTime.tryParse('${c['startedAt']}'),
      error: c['error'] as String?,
      costPerHour: (c['costPerHour'] as num?)?.toDouble() ?? 0,
      autoStopAfterIdleMin: (c['autoStopAfterIdleMin'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Where an event's main YouTube stream goes.
enum YoutubeSource {
  /// The organisation's own connected channel.
  org,

  /// The platform's Go Live channel: nothing to connect (unlisted, "<event> by <organisation>").
  golive,

  /// A stream key pasted from YouTube Studio.
  key;

  static YoutubeSource parse(Object? v) => switch (v) {
        'golive' => YoutubeSource.golive,
        'key' => YoutubeSource.key,
        _ => YoutubeSource.org,
      };
}

class YoutubeState {
  const YoutubeState({
    this.source = YoutubeSource.org,
    this.goliveAvailable = false,
    this.connected = false,
    this.channelTitle,
    this.broadcastId,
    this.watchUrl,
    this.privacy,
    this.lifeCycleStatus,
    this.streamStatus,
    this.health,
    this.issues = const [],
    this.error,
  });

  final YoutubeSource source;
  final bool goliveAvailable;
  final bool connected;
  final String? channelTitle;
  final String? broadcastId;
  final String? watchUrl;
  final String? privacy;
  final String? lifeCycleStatus;
  final String? streamStatus;
  final String? health;
  final List<String> issues;
  final String? error;

  bool get hasBroadcast => broadcastId != null;

  /// YouTube's lifecycle words, in plain English.
  String get statusLabel => switch (lifeCycleStatus) {
        'created' || 'ready' => 'Ready',
        'testing' || 'testStarting' => 'Preparing',
        'liveStarting' => 'Starting',
        'live' => 'Live',
        'complete' => 'Ended',
        'revoked' => 'Removed',
        null => hasBroadcast ? 'Created' : 'No broadcast',
        _ => lifeCycleStatus!,
      };

  factory YoutubeState.fromJson(Map<String, dynamic>? j) => j == null
      ? const YoutubeState()
      : YoutubeState(
          source: YoutubeSource.parse(j['source']),
          goliveAvailable: (j['goliveAvailable'] as bool?) ?? false,
          connected: (j['connected'] as bool?) ?? false,
          channelTitle: j['channelTitle'] as String?,
          broadcastId: j['broadcastId'] as String?,
          watchUrl: j['watchUrl'] as String?,
          privacy: j['privacy'] as String?,
          lifeCycleStatus: j['lifeCycleStatus'] as String?,
          streamStatus: j['streamStatus'] as String?,
          health: j['health'] as String?,
          issues: ((j['issues'] as List?) ?? const []).map((e) => '$e').toList(),
          error: j['error'] as String?,
        );
}

class OrgYoutube {
  const OrgYoutube({this.enabled = false, this.connected = false, this.channelTitle});
  final bool enabled;
  final bool connected;
  final String? channelTitle;

  factory OrgYoutube.fromJson(Map<String, dynamic> j) => OrgYoutube(
        enabled: (j['enabled'] as bool?) ?? false,
        connected: (j['connected'] as bool?) ?? false,
        channelTitle: j['channelTitle'] as String?,
      );
}

class FacebookPage {
  const FacebookPage({required this.id, required this.name});
  final String id;
  final String name;
}

class OrgFacebook {
  const OrgFacebook({this.enabled = false, this.connected = false, this.userName, this.pages = const [], this.pageId, this.pageName});
  final bool enabled;
  final bool connected;
  final String? userName;
  final List<FacebookPage> pages;
  final String? pageId;
  final String? pageName;

  factory OrgFacebook.fromJson(Map<String, dynamic> j) => OrgFacebook(
        enabled: (j['enabled'] as bool?) ?? false,
        connected: (j['connected'] as bool?) ?? false,
        userName: j['userName'] as String?,
        pages: ((j['pages'] as List?) ?? const [])
            .map((p) => FacebookPage(id: '${(p as Map)['id']}', name: '${p['name']}'))
            .toList(),
        pageId: j['pageId'] as String?,
        pageName: j['pageName'] as String?,
      );
}

// ---------------------------------------------------------------- streaming platforms

enum StreamPlatform { youtube, facebook, instagram }

extension PlatformX on StreamPlatform {
  String get label => switch (this) {
        StreamPlatform.youtube => 'YouTube',
        StreamPlatform.facebook => 'Facebook',
        StreamPlatform.instagram => 'Instagram',
      };
}

/// One platform the programme is restreamed to. `state` is off until OBS is streaming.
class PlatformOutput {
  const PlatformOutput({
    required this.platform,
    this.configured = false,
    this.enabled = false,
    this.state = 'off',
    this.error,
    this.link,
    this.hint,
  });

  final StreamPlatform platform;
  final bool configured;
  final bool enabled;

  /// off | connecting | live | retrying
  final String state;
  final String? error;
  final String? link;
  final String? hint;

  bool get active => configured && enabled;
  bool get live => state == 'live';

  factory PlatformOutput.fromJson(Map<String, dynamic> j) => PlatformOutput(
        platform: StreamPlatform.values.firstWhere((p) => p.name == j['platform'], orElse: () => StreamPlatform.youtube),
        configured: (j['configured'] as bool?) ?? false,
        enabled: (j['enabled'] as bool?) ?? false,
        state: (j['state'] as String?) ?? 'off',
        error: j['error'] as String?,
        link: j['link'] as String?,
        hint: j['hint'] as String?,
      );
}

/// An extra place this event streams to: another connected YouTube channel, or a pasted
/// stream key (YouTube, Facebook, Instagram or any RTMP service).
class DestinationOutput {
  const DestinationOutput({
    required this.id,
    required this.kind,
    required this.platform,
    required this.label,
    this.enabled = true,
    this.ready = false,
    this.channelId,
    this.privacy,
    this.vertical = false,
    this.hint,
    this.link,
    this.state = 'off',
    this.error,
  });

  final String id;

  /// channel | key
  final String kind;

  /// youtube | facebook | instagram | other
  final String platform;
  final String label;
  final bool enabled;
  final bool ready;
  final String? channelId;
  final String? privacy;
  final bool vertical;
  final String? hint;
  final String? link;

  /// off | connecting | live | retrying
  final String state;
  final String? error;

  bool get active => enabled && ready;
  bool get live => state == 'live';
  bool get isChannel => kind == 'channel';

  String get platformLabel => switch (platform) {
        'youtube' => 'YouTube',
        'facebook' => 'Facebook',
        'instagram' => 'Instagram',
        _ => 'Stream key',
      };

  factory DestinationOutput.fromJson(Map<String, dynamic> j) => DestinationOutput(
        id: '${j['id']}',
        kind: (j['kind'] as String?) ?? 'key',
        platform: (j['platform'] as String?) ?? 'other',
        label: (j['label'] as String?) ?? '',
        enabled: (j['enabled'] as bool?) ?? true,
        ready: (j['ready'] as bool?) ?? false,
        channelId: j['channelId'] as String?,
        privacy: j['privacy'] as String?,
        vertical: (j['vertical'] as bool?) ?? false,
        hint: j['hint'] as String?,
        link: j['link'] as String?,
        state: (j['state'] as String?) ?? 'off',
        error: j['error'] as String?,
      );
}

/// Our own player on the watch page (HLS through the CDN, V7). Null when the platform has it off.
class WatchOutput {
  const WatchOutput({this.enabled = true, this.state = 'off', this.error});

  /// On for this event (a director can switch it off per event).
  final bool enabled;

  /// off | connecting | live | retrying
  final String state;
  final String? error;

  bool get live => state == 'live';

  factory WatchOutput.fromJson(Map<String, dynamic> j) =>
      WatchOutput(enabled: (j['enabled'] as bool?) ?? true, state: (j['state'] as String?) ?? 'off', error: j['error'] as String?);
}

/// The event's watch player: the live link while streaming, replays, and the embed URL.
class WatchInfo {
  const WatchInfo({this.available = false, this.enabled = true, this.live, this.replays = const [], this.embedUrl, this.watchPage, this.publicWatch = true});

  final bool available;
  final bool enabled;
  final String? live;
  final List<WatchReplay> replays;
  final String? embedUrl;
  final String? watchPage;
  final bool publicWatch;

  factory WatchInfo.fromJson(Map<String, dynamic> j) {
    final w = (j['watch'] as Map<String, dynamic>?) ?? const {};
    return WatchInfo(
      available: (j['available'] as bool?) ?? false,
      enabled: (j['enabled'] as bool?) ?? true,
      live: w['live'] as String?,
      replays: ((w['replays'] as List?) ?? const []).map((r) => WatchReplay.fromJson(r as Map<String, dynamic>)).toList(),
      embedUrl: w['embedUrl'] as String?,
      watchPage: j['watchPage'] as String?,
      publicWatch: (j['publicWatch'] as bool?) ?? true,
    );
  }
}

class WatchReplay {
  const WatchReplay({required this.url, required this.startedAt, required this.durationSec});

  final String url;
  final DateTime startedAt;
  final int durationSec;

  /// "1 h 20 min", "45 min".
  String get lengthLabel {
    if (durationSec >= 3600) return '${durationSec ~/ 3600} h ${(durationSec % 3600) ~/ 60} min';
    return '${(durationSec / 60).round().clamp(1, 59)} min';
  }

  factory WatchReplay.fromJson(Map<String, dynamic> j) => WatchReplay(
        url: '${j['url']}',
        startedAt: DateTime.tryParse('${j['startedAt']}')?.toLocal() ?? DateTime.now(),
        durationSec: (j['durationSec'] as num?)?.toInt() ?? 0,
      );
}

class OutputsState {
  const OutputsState({this.relay = false, this.platforms = const [], this.destinations = const [], this.watch});

  /// OBS sends one stream to the server, which restreams it to each platform.
  final bool relay;
  final List<PlatformOutput> platforms;
  final List<DestinationOutput> destinations;

  /// Our watch page player; null when it is off for the whole platform.
  final WatchOutput? watch;

  /// The watch page plays the show with our own player.
  bool get watchActive => watch?.enabled ?? false;

  PlatformOutput of(StreamPlatform p) =>
      platforms.firstWhere((x) => x.platform == p, orElse: () => PlatformOutput(platform: p));

  List<PlatformOutput> get active => platforms.where((p) => p.active).toList();
  List<DestinationOutput> get activeDestinations => destinations.where((d) => d.active).toList();

  /// Everywhere the show goes when the director goes live (the watch page counts as one).
  int get activeCount => active.length + activeDestinations.length + (watchActive ? 1 : 0);

  /// "Watch page + YouTube + 2 more", for the Go live button.
  String get goLiveLabel {
    final names = [if (watchActive) 'Watch page', ...active.map((o) => o.platform.label)];
    final extra = activeDestinations.length;
    if (names.isEmpty && extra == 0) return 'Go live on YouTube';
    if (names.length == 1 && watchActive && extra == 0) return 'Go live on the watch page';
    if (names.isEmpty) return 'Go live: $extra destination${extra == 1 ? '' : 's'}';
    return 'Go live: ${names.join(' + ')}${extra > 0 ? ' + $extra more' : ''}';
  }

  factory OutputsState.fromJson(Map<String, dynamic>? j) => j == null
      ? const OutputsState()
      : OutputsState(
          relay: (j['relay'] as bool?) ?? false,
          platforms: ((j['platforms'] as List?) ?? const []).map((p) => PlatformOutput.fromJson(p as Map<String, dynamic>)).toList(),
          destinations:
              ((j['destinations'] as List?) ?? const []).map((d) => DestinationOutput.fromJson(d as Map<String, dynamic>)).toList(),
          watch: j['watch'] is Map<String, dynamic> ? WatchOutput.fromJson(j['watch'] as Map<String, dynamic>) : null,
        );
}

/// A YouTube channel of the organisation: the main one, or an extra one connected later.
class YoutubeChannel {
  const YoutubeChannel({required this.id, required this.title, this.main = false});

  /// 'main' for the main channel, else the id used to add it to events.
  final String id;
  final String title;
  final bool main;

  factory YoutubeChannel.fromJson(Map<String, dynamic> j) =>
      YoutubeChannel(id: '${j['id']}', title: (j['title'] as String?) ?? 'YouTube channel', main: (j['main'] as bool?) ?? false);
}

// ---------------------------------------------------------------- graphics

class GraphicsState {
  const GraphicsState({
    this.lowerThirdVisible = false,
    this.lowerThirdPlayerId,
    this.lowerThirdTitle = '',
    this.lowerThirdSubtitle = '',
    this.holeCardAuto = true,
    this.holeCardVisible = false,
    this.holeCardHole,
    this.leaderboardVisible = false,
    this.leaderboardSize = 8,
    this.leaderboardCategory,
    this.scoreBugVisible = true,
    this.questionVisible = false,
    this.questionAuthor = '',
    this.questionText = '',
    this.replay = false,
  });

  final bool lowerThirdVisible;
  final String? lowerThirdPlayerId;
  final String lowerThirdTitle;
  final String lowerThirdSubtitle;
  final bool holeCardAuto;
  final bool holeCardVisible;
  final int? holeCardHole;
  final bool leaderboardVisible;
  final int leaderboardSize;
  final String? leaderboardCategory;
  final bool scoreBugVisible;

  /// A viewer's question from the comments, on air.
  final bool questionVisible;
  final String questionAuthor;
  final String questionText;
  final bool replay;

  factory GraphicsState.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const GraphicsState();
    final lt = (j['lowerThird'] as Map<String, dynamic>?) ?? const {};
    final hc = (j['holeCard'] as Map<String, dynamic>?) ?? const {};
    final lb = (j['leaderboard'] as Map<String, dynamic>?) ?? const {};
    final sb = (j['scoreBug'] as Map<String, dynamic>?) ?? const {};
    final q = (j['question'] as Map<String, dynamic>?) ?? const {};
    return GraphicsState(
      lowerThirdVisible: (lt['visible'] as bool?) ?? false,
      lowerThirdPlayerId: lt['playerId'] as String?,
      lowerThirdTitle: (lt['title'] as String?) ?? '',
      lowerThirdSubtitle: (lt['subtitle'] as String?) ?? '',
      holeCardAuto: (hc['auto'] as bool?) ?? true,
      holeCardVisible: (hc['visible'] as bool?) ?? false,
      holeCardHole: (hc['hole'] as num?)?.toInt(),
      leaderboardVisible: (lb['visible'] as bool?) ?? false,
      leaderboardSize: (lb['size'] as num?)?.toInt() ?? 8,
      leaderboardCategory: lb['category'] as String?,
      scoreBugVisible: (sb['visible'] as bool?) ?? true,
      questionVisible: (q['visible'] as bool?) ?? false,
      questionAuthor: (q['author'] as String?) ?? '',
      questionText: (q['text'] as String?) ?? '',
      replay: (j['replay'] as bool?) ?? false,
    );
  }
}

// ---------------------------------------------------------------- audio

class CameraMix {
  const CameraMix({this.db = 0, this.muted = false});
  final double db;
  final bool muted;
}

class AudioState {
  const AudioState({
    this.courseDb = 0,
    this.courseMuted = false,
    this.cameras = const {},
    this.commentaryDb = 0,
    this.commentaryMuted = false,
    this.ducking = true,
    this.commentaryDelayMs = 0,
  });

  final double courseDb;
  final bool courseMuted;
  final Map<String, CameraMix> cameras;
  final double commentaryDb;
  final bool commentaryMuted;
  final bool ducking;
  final int commentaryDelayMs;

  CameraMix camera(String id) => cameras[id] ?? const CameraMix();

  factory AudioState.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const AudioState();
    final cams = <String, CameraMix>{};
    final raw = j['cameras'];
    if (raw is Map) {
      raw.forEach((k, v) {
        if (v is Map) cams['$k'] = CameraMix(db: (v['db'] as num?)?.toDouble() ?? 0, muted: (v['muted'] as bool?) ?? false);
      });
    }
    return AudioState(
      courseDb: (j['courseDb'] as num?)?.toDouble() ?? 0,
      courseMuted: (j['courseMuted'] as bool?) ?? false,
      cameras: cams,
      commentaryDb: (j['commentaryDb'] as num?)?.toDouble() ?? 0,
      commentaryMuted: (j['commentaryMuted'] as bool?) ?? false,
      ducking: (j['ducking'] as bool?) ?? true,
      commentaryDelayMs: (j['commentaryDelayMs'] as num?)?.toInt() ?? 0,
    );
  }
}

// ---------------------------------------------------------------- scoring

class Hole {
  const Hole({required this.number, required this.par, this.yardage});
  final int number;
  final int par;
  final int? yardage;

  factory Hole.fromJson(Map<String, dynamic> j) =>
      Hole(number: (j['number'] as num).toInt(), par: (j['par'] as num).toInt(), yardage: (j['yardage'] as num?)?.toInt());
}

class Player {
  const Player({required this.id, required this.name, this.club, this.category, this.groupNo});
  final String id;
  final String name;
  final String? club;
  final String? category;
  final int? groupNo;

  factory Player.fromJson(Map<String, dynamic> j) => Player(
        id: j['id'] as String,
        name: (j['name'] as String?) ?? '',
        club: j['club'] as String?,
        category: j['category'] as String?,
        groupNo: (j['groupNo'] as num?)?.toInt(),
      );
}

class LeaderboardRow {
  const LeaderboardRow({
    required this.playerId,
    required this.name,
    this.club,
    this.category,
    this.groupNo,
    this.position = '',
    this.toParText = '–',
    this.thru = '–',
    this.strokes = 0,
    this.toPar,
    this.scores = const {},
  });

  final String playerId;
  final String name;
  final String? club;
  final String? category;
  final int? groupNo;
  final String position;
  final String toParText;
  final String thru;
  final int strokes;
  final int? toPar;

  /// Strokes by hole number.
  final Map<int, int> scores;

  factory LeaderboardRow.fromJson(Map<String, dynamic> j) {
    final scores = <int, int>{};
    final raw = j['scores'];
    if (raw is Map) {
      raw.forEach((k, v) {
        final hole = int.tryParse('$k');
        if (hole != null && v is num) scores[hole] = v.toInt();
      });
    }
    return LeaderboardRow(
      playerId: j['playerId'] as String,
      name: (j['name'] as String?) ?? '',
      club: j['club'] as String?,
      category: j['category'] as String?,
      groupNo: (j['groupNo'] as num?)?.toInt(),
      position: (j['position'] as String?) ?? '',
      toParText: (j['toParText'] as String?) ?? '–',
      thru: (j['thru'] as String?) ?? '–',
      strokes: (j['strokes'] as num?)?.toInt() ?? 0,
      toPar: (j['toPar'] as num?)?.toInt(),
      scores: scores,
    );
  }
}

List<LeaderboardRow> parseLeaderboard(Object? list) =>
    ((list as List?) ?? const []).map((r) => LeaderboardRow.fromJson(r as Map<String, dynamic>)).toList();

// ---------------------------------------------------------------- clips

enum ClipStatus { queued, processing, ready, failed }

class HighlightClip {
  const HighlightClip({
    required this.id,
    required this.tournamentId,
    this.cameraId,
    this.cameraName,
    this.hole,
    this.title,
    this.durationSec = 0,
    this.status = ClipStatus.queued,
    this.error,
    this.sizeBytes,
    this.createdAt,
    this.thumbPath,
    this.landscapePath,
    this.verticalPath,
    this.isPublic = true,
  });

  final String id;
  final String tournamentId;
  final String? cameraId;
  final String? cameraName;
  final int? hole;
  final String? title;
  final int durationSec;
  final ClipStatus status;
  final String? error;
  final int? sizeBytes;
  final DateTime? createdAt;
  final String? thumbPath;
  final String? landscapePath;
  final String? verticalPath;

  /// Shown on the public watch page.
  final bool isPublic;

  bool get working => status == ClipStatus.queued || status == ClipStatus.processing;

  String get headline {
    if (title != null && title!.isNotEmpty) return title!;
    return [cameraName, if (hole != null) 'Hole $hole'].whereType<String>().join(' · ');
  }

  factory HighlightClip.fromJson(Map<String, dynamic> j) {
    final files = j['files'] as Map<String, dynamic>?;
    return HighlightClip(
      id: j['id'] as String,
      tournamentId: j['tournamentId'] as String,
      cameraId: j['cameraId'] as String?,
      cameraName: j['cameraName'] as String?,
      hole: (j['hole'] as num?)?.toInt(),
      title: j['title'] as String?,
      durationSec: (j['durationSec'] as num?)?.toInt() ?? 0,
      status: ClipStatus.values.firstWhere((s) => s.name == j['status'], orElse: () => ClipStatus.queued),
      error: j['error'] as String?,
      sizeBytes: (j['sizeBytes'] as num?)?.toInt(),
      createdAt: j['createdAt'] == null ? null : DateTime.tryParse('${j['createdAt']}'),
      thumbPath: files?['thumb'] as String?,
      landscapePath: files?['landscape'] as String?,
      verticalPath: files?['vertical'] as String?,
      isPublic: (j['public'] as bool?) ?? true,
    );
  }
}

class ClipLinks {
  const ClipLinks({required this.landscapeUrl, required this.verticalUrl, required this.thumbUrl, this.expiresAt});
  final String landscapeUrl;
  final String verticalUrl;
  final String thumbUrl;
  final DateTime? expiresAt;

  factory ClipLinks.fromJson(Map<String, dynamic> j) => ClipLinks(
        landscapeUrl: j['landscapeUrl'] as String,
        verticalUrl: j['verticalUrl'] as String,
        thumbUrl: j['thumbUrl'] as String,
        expiresAt: j['expiresAt'] == null ? null : DateTime.tryParse('${j['expiresAt']}'),
      );
}

// ---------------------------------------------------------------- misc

class AlertMessage {
  AlertMessage({required this.level, required this.message, DateTime? at}) : at = at ?? DateTime.now();
  final String level; // info | warning | error
  final String message;
  final DateTime at;
}

// ---------------------------------------------------------------- billing

double _d(Object? v) => (v as num?)?.toDouble() ?? 0;

/// "12.5" → "12.5", "12.0" → "12": credits and rupees without needless decimals.
String formatAmount(double v) {
  final s = v.toStringAsFixed(2);
  final t = s.replaceAll(RegExp(r'0+$'), '').replaceAll(RegExp(r'\.$'), '');
  final parts = t.split('.');
  final whole = parts[0].replaceAllMapped(RegExp(r'(\d)(?=(\d{2})+\d$)'), (m) => '${m[1]},'); // Indian grouping
  return parts.length > 1 ? '$whole.${parts[1]}' : whole;
}

class BillingPricing {
  const BillingPricing({
    this.freeCameras = 2,
    this.freeMinutes = 10,
    this.cameraPrice = 0,
    this.minutePrice = 0,
    this.graceMinutes = 5,
    this.freeDestinations = 1,
    this.destinationPrice = 0,
  });
  final int freeCameras;
  final int freeMinutes;
  final double cameraPrice;
  final double minutePrice;
  final int graceMinutes;
  final int freeDestinations;
  final double destinationPrice;

  factory BillingPricing.fromJson(Map<String, dynamic>? j) => j == null
      ? const BillingPricing()
      : BillingPricing(
          freeCameras: (j['freeCameras'] as num?)?.toInt() ?? 2,
          freeMinutes: (j['freeMinutes'] as num?)?.toInt() ?? 10,
          cameraPrice: _d(j['cameraPrice']),
          minutePrice: _d(j['minutePrice']),
          graceMinutes: (j['graceMinutes'] as num?)?.toInt() ?? 5,
          freeDestinations: (j['freeDestinations'] as num?)?.toInt() ?? 1,
          destinationPrice: _d(j['destinationPrice']),
        );
}

class CreditPack {
  const CreditPack({required this.id, required this.label, required this.priceInr, required this.credits});
  final String id;
  final String label;
  final double priceInr;
  final double credits;

  /// Extra credits over the rupee price, as a whole percentage (0 = none).
  int get bonusPercent => priceInr > 0 && credits > priceInr ? ((credits / priceInr - 1) * 100).round() : 0;

  factory CreditPack.fromJson(Map<String, dynamic> j) =>
      CreditPack(id: '${j['id']}', label: '${j['label']}', priceInr: _d(j['priceInr']), credits: _d(j['credits']));
}

enum WalletKind { purchase, cameras, minutes, admin, refund, destinations, viewership, messages }

class WalletTx {
  const WalletTx({required this.kind, required this.credits, this.quantity, this.tournamentName, this.note, required this.at});
  final WalletKind kind;
  final double credits;
  final int? quantity;
  final String? tournamentName;
  final String? note;
  final DateTime at;

  String get title => switch (kind) {
        WalletKind.purchase => 'Bought credits',
        WalletKind.cameras => quantity == 1 ? 'Extra camera' : 'Extra cameras ($quantity)',
        WalletKind.minutes => 'Live minutes (${quantity ?? 0})',
        WalletKind.admin => note ?? 'Adjusted by CoGolfers',
        WalletKind.refund => 'Refund',
        WalletKind.destinations => note ?? 'Extra destinations',
        WalletKind.viewership => 'Influencers & games',
        WalletKind.messages => 'SMS messages (${quantity ?? 0})',
      };

  factory WalletTx.fromJson(Map<String, dynamic> j) => WalletTx(
        kind: WalletKind.values.firstWhere((k) => k.name == j['kind'], orElse: () => WalletKind.admin),
        credits: _d(j['credits']),
        quantity: (j['quantity'] as num?)?.toInt(),
        tournamentName: j['tournamentName'] as String?,
        note: j['note'] as String?,
        at: DateTime.tryParse('${j['at']}')?.toLocal() ?? DateTime.now(),
      );
}

class BillingDetails {
  const BillingDetails({this.name, this.phone, this.email, this.gstin});
  final String? name;
  final String? phone;
  final String? email;
  final String? gstin;

  factory BillingDetails.fromJson(Map<String, dynamic> j) =>
      BillingDetails(name: j['name'] as String?, phone: j['phone'] as String?, email: j['email'] as String?, gstin: j['gstin'] as String?);
}

/// A club's wallet as the organiser sees it.
class OrgBilling {
  const OrgBilling({
    this.enabled = false,
    this.balance = 0,
    this.pricing = const BillingPricing(),
    this.packs = const [],
    this.paymentsEnabled = false,
    this.suspended = false,
    this.suspendedReason,
    this.details,
    this.transactions = const [],
  });
  final bool enabled;
  final double balance;
  final BillingPricing pricing;
  final List<CreditPack> packs;
  final bool paymentsEnabled;
  final bool suspended;
  final String? suspendedReason;

  /// Owners only.
  final BillingDetails? details;
  final List<WalletTx> transactions;

  factory OrgBilling.fromJson(Map<String, dynamic> j) => OrgBilling(
        enabled: (j['enabled'] as bool?) ?? false,
        balance: _d(j['balance']),
        pricing: BillingPricing.fromJson(j['pricing'] as Map<String, dynamic>?),
        packs: ((j['packs'] as List?) ?? const []).map((p) => CreditPack.fromJson(p as Map<String, dynamic>)).toList(),
        paymentsEnabled: (j['paymentsEnabled'] as bool?) ?? false,
        suspended: (j['suspended'] as bool?) ?? false,
        suspendedReason: j['suspendedReason'] as String?,
        details: j['details'] is Map<String, dynamic> ? BillingDetails.fromJson(j['details'] as Map<String, dynamic>) : null,
        transactions: ((j['transactions'] as List?) ?? const []).map((t) => WalletTx.fromJson(t as Map<String, dynamic>)).toList(),
      );
}

/// Camera slots and live minutes of one tournament (REST and the WebSocket `billing` message).
class TournamentBilling {
  const TournamentBilling({
    this.enabled = false,
    this.suspended = false,
    this.suspendedReason,
    this.balance = 0,
    this.pricing = const BillingPricing(),
    this.camerasFree = 0,
    this.camerasExtra = 0,
    this.cameraLimit = 0,
    this.camerasUsed = 0,
    this.destinationsFree = 1,
    this.destinationsExtra = 0,
    this.destinationLimit = 1,
    this.destinationsUsed = 0,
    this.destinationPrice = 0,
    this.liveSeconds = 0,
    this.freeSecondsLeft = 0,
    this.remainingSeconds,
    this.graceActive = false,
    this.graceSecondsLeft,
    this.canGoLive = true,
    this.reason,
  });
  final bool enabled;
  final bool suspended;
  final String? suspendedReason;
  final double balance;
  final BillingPricing pricing;
  final int camerasFree;
  final int camerasExtra;
  final int cameraLimit;
  final int camerasUsed;

  /// Destinations (YouTube channels, Facebook, Instagram, stream keys) included in this event.
  final int destinationsFree;
  final int destinationsExtra;
  final int destinationLimit;
  final int destinationsUsed;
  final double destinationPrice;
  final int liveSeconds;
  final int freeSecondsLeft;

  /// Live time left before the grace period; null = no limit.
  final int? remainingSeconds;
  final bool graceActive;
  final int? graceSecondsLeft;
  final bool canGoLive;
  final String? reason;

  int? get remainingMinutes => remainingSeconds == null ? null : remainingSeconds! ~/ 60;
  bool get low => remainingSeconds != null && remainingSeconds! <= 600;
  int get freeCameraSlotsLeft => (cameraLimit - camerasUsed).clamp(0, 1000);

  /// Room for one more destination without buying (always true when billing is off).
  bool get destinationRoom => !enabled || destinationsUsed < destinationLimit;

  factory TournamentBilling.fromJson(Map<String, dynamic>? j) {
    if (j == null) return const TournamentBilling();
    final cams = (j['cameras'] as Map<String, dynamic>?) ?? const {};
    final mins = (j['minutes'] as Map<String, dynamic>?) ?? const {};
    final grace = (j['grace'] as Map<String, dynamic>?) ?? const {};
    final dest = (j['destinations'] as Map<String, dynamic>?) ?? const {};
    return TournamentBilling(
      enabled: (j['enabled'] as bool?) ?? false,
      suspended: (j['suspended'] as bool?) ?? false,
      suspendedReason: j['suspendedReason'] as String?,
      balance: _d(j['balance']),
      pricing: BillingPricing.fromJson(j['pricing'] as Map<String, dynamic>?),
      camerasFree: (cams['free'] as num?)?.toInt() ?? 0,
      camerasExtra: (cams['extra'] as num?)?.toInt() ?? 0,
      cameraLimit: (cams['limit'] as num?)?.toInt() ?? 0,
      camerasUsed: (cams['used'] as num?)?.toInt() ?? 0,
      destinationsFree: (dest['free'] as num?)?.toInt() ?? 1,
      destinationsExtra: (dest['extra'] as num?)?.toInt() ?? 0,
      destinationLimit: (dest['limit'] as num?)?.toInt() ?? 1,
      destinationsUsed: (dest['used'] as num?)?.toInt() ?? 0,
      destinationPrice: _d(dest['price']),
      liveSeconds: (mins['liveSeconds'] as num?)?.toInt() ?? 0,
      freeSecondsLeft: (mins['freeSecondsLeft'] as num?)?.toInt() ?? 0,
      remainingSeconds: (mins['remainingSeconds'] as num?)?.toInt(),
      graceActive: (grace['active'] as bool?) ?? false,
      graceSecondsLeft: (grace['secondsLeft'] as num?)?.toInt(),
      canGoLive: (j['canGoLive'] as bool?) ?? true,
      reason: j['reason'] as String?,
    );
  }
}

enum PaymentStatus { created, paid, failed, expired }

class PaymentInfo {
  const PaymentInfo({required this.id, required this.status, required this.amountInr, required this.credits});
  final String id;
  final PaymentStatus status;
  final double amountInr;
  final double credits;

  factory PaymentInfo.fromJson(Map<String, dynamic> j) => PaymentInfo(
        id: '${j['id']}',
        status: PaymentStatus.values.firstWhere((s) => s.name == j['status'], orElse: () => PaymentStatus.created),
        amountInr: _d(j['amountInr']),
        credits: _d(j['credits']),
      );
}

// ---------------------------------------------------------------- viewer comments

enum ChatSource { watch, youtube, facebook }

extension ChatSourceX on ChatSource {
  String get label => switch (this) {
        ChatSource.watch => 'CoGolfers',
        ChatSource.youtube => 'YouTube',
        ChatSource.facebook => 'Facebook',
      };
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.source,
    required this.author,
    required this.text,
    this.question = false,
    this.pinned = false,
    this.hidden = false,
    this.answered = false,
    required this.at,
  });
  final int id;
  final ChatSource source;
  final String author;
  final String text;
  final bool question;
  final bool pinned;
  final bool hidden;
  final bool answered;
  final DateTime at;

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: (j['id'] as num).toInt(),
        source: ChatSource.values.firstWhere((s) => s.name == j['source'], orElse: () => ChatSource.watch),
        author: '${j['author'] ?? ''}',
        text: '${j['text'] ?? ''}',
        question: (j['question'] as bool?) ?? false,
        pinned: (j['pinned'] as bool?) ?? false,
        hidden: (j['hidden'] as bool?) ?? false,
        answered: (j['answered'] as bool?) ?? false,
        at: DateTime.tryParse('${j['at']}')?.toLocal() ?? DateTime.now(),
      );
}

/// Whether YouTube / Facebook comments are being read right now.
class ChatSourceStatus {
  const ChatSourceStatus({this.state = 'off', this.error});
  final String state; // off · reading · error
  final String? error;

  factory ChatSourceStatus.fromJson(Map<String, dynamic>? j) =>
      j == null ? const ChatSourceStatus() : ChatSourceStatus(state: '${j['state'] ?? 'off'}', error: j['error'] as String?);
}

class ChatFeed {
  const ChatFeed({
    this.enabled = true,
    this.slowSec = 3,
    this.version = 0,
    this.youtube = const ChatSourceStatus(),
    this.facebook = const ChatSourceStatus(),
    this.messages = const [],
  });
  final bool enabled;
  final int slowSec;
  final int version;
  final ChatSourceStatus youtube;
  final ChatSourceStatus facebook;
  final List<ChatMessage> messages;

  /// Null when the server says nothing changed since `version`.
  static ChatFeed? fromJson(Map<String, dynamic> j) {
    if (j['unchanged'] == true) return null;
    final src = (j['sources'] as Map<String, dynamic>?) ?? const {};
    return ChatFeed(
      enabled: (j['enabled'] as bool?) ?? true,
      slowSec: (j['slowSec'] as num?)?.toInt() ?? 3,
      version: (j['version'] as num?)?.toInt() ?? 0,
      youtube: ChatSourceStatus.fromJson(src['youtube'] as Map<String, dynamic>?),
      facebook: ChatSourceStatus.fromJson(src['facebook'] as Map<String, dynamic>?),
      messages: ((j['messages'] as List?) ?? const []).map((m) => ChatMessage.fromJson(m as Map<String, dynamic>)).toList(),
    );
  }
}

/// The home-screen checklist (P1-12): Account, Channel, Cameras, Test, Live.
class OnboardingChecklist {
  const OnboardingChecklist({this.channel = false, this.cameras = false, this.test = false, this.live = false, this.hasEvent = false});
  final bool channel;
  final bool cameras;
  final bool test;
  final bool live;
  final bool hasEvent;

  bool get done => live;
  int get count => 1 + [channel, cameras, test, live].where((x) => x).length;

  factory OnboardingChecklist.fromJson(Map<String, dynamic> j) {
    final s = (j['steps'] as Map<String, dynamic>?) ?? const {};
    return OnboardingChecklist(
      channel: s['channel'] == true,
      cameras: s['cameras'] == true,
      test: s['test'] == true,
      live: s['live'] == true,
      hasEvent: j['hasEvent'] == true,
    );
  }
}

/// A game on the watch page (quiz, poll, prediction, spin), as the director's list shows it.
class GameMoment {
  const GameMoment({required this.id, required this.type, required this.title, required this.clock, this.options = const [], this.enabled = true, this.running = false, this.pick, this.prize});
  final String id;
  final String type;
  final String title;
  final String clock;
  final List<(String, String)> options;
  final bool enabled;
  final bool running;

  /// How winners are picked (draw, first_correct, spin), or null for no prize.
  final String? pick;
  final String? prize;

  String get typeLabel => switch (type) { 'quiz' => 'Quiz', 'poll' => 'Poll', 'prediction' => 'Prediction', 'spin' => 'Spin the wheel', 'draw' => 'Lucky draw', _ => 'Game' };
  String get clockLabel => switch (clock) { 'director' => 'Fire when you like', 'stream' => 'On the stream clock', _ => 'On each viewer’s clock' };

  /// From GET /api/tournaments/:id/moments (moments + runs).
  static List<GameMoment> listFromJson(Map<String, dynamic> j) {
    final now = DateTime.now();
    final open = <String>{
      for (final r in (j['runs'] as List? ?? const []).cast<Map<String, dynamic>>())
        if ((DateTime.tryParse('${r['closesAt']}') ?? now).isAfter(now)) r['momentId'] as String,
    };
    return [
      for (final m in (j['moments'] as List? ?? const []).cast<Map<String, dynamic>>())
        GameMoment(
          id: m['id'] as String,
          type: (m['type'] as String?) ?? 'quiz',
          title: (m['title'] as String?) ?? '',
          clock: (m['clock'] as String?) ?? 'director',
          options: [for (final o in (m['options'] as List? ?? const []).cast<Map<String, dynamic>>()) ('${o['id']}', '${o['text']}')],
          enabled: m['enabled'] != false,
          running: open.contains(m['id']),
          pick: m['pick'] as String?,
          prize: m['prize'] as String?,
        ),
    ];
  }
}
