# Architecture

```
 VOLUNTEERS (QR code, no account)        SERVER VM (docker compose)                       BROADCAST ENGINE
 ┌──────────────────────────┐ SRT 8890  ┌──────────────────────────────────────┐ SRT feeds  ┌──────────────────────────┐
 │ Camera phones            │ ────────▶ │ MediaMTX: ingest, recording,          │ ─────────▶ │ OBS Studio + agent        │
 │  (Android / iOS, SRT)    │           │  playback, WebRTC, auth hook          │            │  scene per camera,        │
 ├──────────────────────────┤ WHIP      │                                       │ programme  │  CG Layers (commentary +  │
 │ Commentators (mic, Opus) │ ────────▶ │                                       │ ◀───────── │  graphics), replay,       │
 ├──────────────────────────┤ HTTPS     │ server (Node, Fastify, Postgres)      │ one SRT    │  fallback, ducking        │
 │ Scorers (offline queue)  │ ────────▶ │  accounts, clubs, join codes, scoring │ stream     └──────────────────────────┘
 └──────────────────────────┘           │  graphics page, replays + clips       │ ◀── WSS ──  laptop at the course OR
                                        │  YouTube + Facebook APIs              │             container per event (cloud)
 DIRECTOR (account)        HTTPS/WSS    │  restream relays ─────────────────────┼──▶ YouTube (copy)
 ┌──────────────────────────┐ ◀───────▶ │  public watch page + API              │──▶ Facebook Page (copy)
 │ control room, graphics,  │ WHEP      │ Caddy: TLS, /webrtc                   │──▶ Instagram (9:16 re-encode)
 │ replay, audio, Go live   │ ◀──────── └──────────────────────────────────────┘
 └──────────────────────────┘                      ▲ JSON only
                                   CoGolfers website / fans: /watch page, YouTube player embedded
```

## Components

| Component | Where | Tech | Role |
|---|---|---|---|
| Mobile app | Android phones/tablets, iPhone, iPad | Flutter 3.44+, Dart; Kotlin + Swift native plugin | One app, five jobs chosen by role: camera, scorer, commentator, director, organiser. No WebView |
| `cg_streamer` plugin | `mobile/packages/cg_streamer` | Kotlin: RootEncoder 2.8.1. Swift: HaishinKit 2.2.5 | Camera capture, H.264/AAC, SRT publish, foreground service (Android), interruption reporting (iOS) |
| Ingest | server VM | MediaMTX 1.21.2 | SRT from phones, SRT to OBS, WebRTC (WHEP previews, WHIP commentary), recording every feed in 1 s fMP4 parts, playback API for replays and clips |
| Server | server VM | Node 22, Fastify 5, Postgres 16, FFmpeg | Accounts, organisations, join codes, tournaments, scoring, graphics, replays/clips, YouTube, cloud engines, real-time hub, MediaMTX auth hook |
| Broadcast engine | laptop **or** container | OBS Studio 30+ + Node agent (obs-websocket v5) | Real switching, transitions, commentary mix with ducking, graphics overlay, replays; sends one programme stream to the server |
| Restream relays | server VM | FFmpeg, one process per platform | Forward the programme to YouTube, Facebook and Instagram (9:16) |
| Watch page + public API | server VM | HTML + JSON, 5 s cache | What fans and the CoGolfers website use: embedded YouTube player, leaderboard, clips |
| Graphics overlay | served by the server | HTML page, Server-Sent Events | Transparent 1920×1080 page used as an OBS Browser Source: score bug, leaderboard, hole card, lower third, replay bug |

## The two production modes

| | Laptop mode | Cloud mode |
|---|---|---|
| OBS runs on | a laptop at the course (or in the clubhouse) | a container the server starts for the event (`infra/cloud-engine`: Xvfb + OBS + agent) |
| Connects with | the engine key from *Tournament > Engine setup (.env)* | the same engine key, injected by the server |
| Camera feeds travel | VM → laptop (download ~2.6 Mbps per camera) | stay inside the VM (no extra internet traffic) |
| Platforms (YouTube, Facebook, Instagram) fed by | the server's relays (the laptop uploads one stream to the server) | the server's relays |
| Start / stop | someone runs OBS and `npm start` | **Start cloud engine** in the app; auto-stops after N idle minutes and after a maximum duration |
| Best when | the venue has good upload and a capable laptop | no laptop or weak venue internet; simplest for volunteers |

The server sends both kinds of engine the same `engine.config`. A tournament can switch mode between events (blocked while an engine is running or the stream is live).

## Who does what (roles)

| Role | Gets in by | Can |
|---|---|---|
| Owner | sign-up ("New club") | everything below + staff management + Connect YouTube |
| Director | added by an owner | create tournaments, join codes, course/players, control room, graphics, replays, clips, audio, YouTube, cloud engine |
| Scorer | join code (or staff account) | enter scores, see leaderboard |
| Commentator | join code (or staff account) | send microphone, watch programme preview, see leaderboard |
| Camera | join code (or staff account) | register a phone as a camera and publish |
| Engine | engine key | the OBS agent only |

Capabilities live in one table (`server/src/authz.ts`) used by REST, the WebSocket hub and the MediaMTX auth hook. Volunteer tokens are scoped to one tournament and expire after 2 days; joining again from the same phone keeps the same camera slot.

## Switching path (CUT)

1. Director taps **CUT** → WebSocket `command {action:"cut", cameraId, requestId}`.
2. Server checks capability, engine online, OBS connected → forwards `command {id, sceneName}` to the agent.
3. Agent calls `SetCurrentProgramScene("CG cam-xxxx")`.
4. OBS emits `CurrentProgramSceneChanged` → agent sends `engine.state` → directors get `engine`, phones get `tally`, the graphics page shows the hole card for the new hole.
5. `command.result` closes the request and the switch is logged.

The app never assumes a switch worked: the programme shown is the one OBS confirmed (manual switches in OBS are followed too).

## Commentary and graphics in OBS

OBS Studio Mode duplicates the programme scene on transition, so sources added to the live scene afterwards would not be heard. The agent therefore keeps commentary inputs and the graphics Browser Source in one nested scene, **CG Layers**, referenced at the top of every camera, fallback and replay scene. Changes to that scene are live immediately on whatever is on air.

- **Commentary:** each commentator is an SRT Media Source (Opus over WebRTC into MediaMTX, read by OBS over SRT). Level, mute and delay (sync offset) are applied per input.
- **Ducking:** a compressor with sidechain on the primary commentator is added to every camera feed; it lowers course audio while they speak.
- **Meters:** OBS `InputVolumeMeters` → agent (throttled 250 ms) → server → control room mixer.
- **Graphics:** Browser Source on `https://<server>/graphics/<tournament>?k=<graphics key>`; the page listens to Server-Sent Events and animates the elements.

## Multistreaming: one OBS stream, three platforms

```
OBS (laptop or cloud) ──SRT, one stream──▶ MediaMTX path prog-<tournament>  (not recorded)
                                                │  server reads it (RTSP, internal)
                       ┌────────────────────────┼─────────────────────────┐
              ffmpeg copy                 ffmpeg copy             ffmpeg re-encode 720×1280
                       ▼                        ▼                         ▼
               YouTube (RTMPS)          Facebook Page (RTMPS)      Instagram (RTMPS)
```

- OBS always sends **one** stream, so a laptop's upload stays ~6 Mbps however many platforms are on. When no platform is set up, OBS streams wherever its own settings / the agent's `.env` say (old behaviour).
- Each platform has its own FFmpeg process: one failing or reconnecting (backoff up to `RELAY_RETRY_MAX_SEC`) never affects the others. Live is detected from FFmpeg's progress (media time moving); the control room shows a pill per platform.
- YouTube and Facebook get the programme **copied** (no quality loss, almost no CPU). Instagram gets a 9:16 version: the full picture centred on a blurred, darkened copy of itself (blur at quarter size; about 1 vCPU at 720p30).
- **YouTube:** broadcast created through the API (now with `enableEmbed`). **Facebook:** the owner connects the club's Facebook account once (Facebook Login, long-lived Page tokens sealed); at *Go live* the server creates a `LIVE_NOW` live video on the chosen Page, at *End* it ends it (kept on the Page as a video). **Instagram:** no API exists; the director pastes the stream URL + key from instagram.com before each event (the key changes every time). Keys are sealed at rest and never shown in errors.
- The programme path is published with a per-tournament `output_key` over SRT only (auth hook). Measured in the end-to-end test: all three platforms live 8.7 s after OBS started.

## Public watch page and API (CoGolfers website)

The video never comes from our servers: the page embeds YouTube's player, and YouTube carries every viewer. Our server only answers small JSON requests.

| Endpoint | Gives |
|---|---|
| `GET /api/public/live` | public tournaments, live first: name, venue, club, live flag, YouTube video id + embed URL, Facebook link, watch page URL |
| `GET /api/public/tournaments/:id` | the same + leaderboard (top 50 with scores), hole on camera, public highlight clips (signed links, 7 days) |
| `GET /watch/:id` (and `/watch`) | ready-made page: player, live leaderboard with category filter, clips, share |

Responses are cached 5 s in memory, so thousands of viewers polling every 10 s cost a handful of DB queries. `PUBLIC_CORS_ORIGINS` lets the CoGolfers website call the API from the browser; `WATCH_EMBED_ORIGINS` lets it embed the page in an `<iframe>`. Directors can hide a tournament (*Public watch page* switch) or a single clip.

## Viewer comments: one chat from three places

- **Sources:** viewers on the CoGolfers watch page (type a name, no account), **YouTube live chat** (`liveChat/messages`, read with the club's YouTube connection) and **Facebook live comments** (`/{live-video}/comments`, read with the Page token). YouTube and Facebook are read only while the tournament is live, each on its own timer with back-off, into one table (`chat_messages`, de-duplicated by the platform's message id).
- **Who sees what:** the watch page shows the combined chat (source icon on each message) and the pinned message; commentators see the same feed with a *Questions / Not answered* filter; directors also hide, pin, block and put a question on air as the **Viewer question** graphic.
- **Load:** the last 200 messages per tournament are kept in memory with a version number. Viewers poll every 3 s with their version: unchanged → a tiny reply; changed → only the new messages and the ids hidden since. Staff apps are nudged over the WebSocket (`chat`).
- **Safety:** names and messages are trimmed, links refused, common English and Hindi abuse masked (`CHAT_BLOCKED_WORDS` adds more), slow mode per viewer (default 3 s) and a per-connection limit; blocking hides all of that author's messages, on any source.
- **Not done:** messages written on the watch page are not posted to YouTube or Facebook, and replies cannot be sent from the app.

## Billing: free allowance, extra cameras, live minutes

- **Per tournament:** `freeCameras` (2) and `freeMinutes` (10) at no cost. More cameras are bought per tournament (`extra_cameras`); camera registration over the limit is refused (402) inside the same transaction that would add the camera, so two phones cannot take the last slot.
- **Live minutes:** a meter runs every few seconds over tournaments whose engine is connected and streaming. It adds time to `live_seconds` (one step is capped at 30 s, so server downtime is not billed) and charges each *started* minute past the free ones from the club wallet, into one growing ledger line per broadcast. Each broadcast is rounded up to its last started minute; nothing carries over.
- **Running out:** warnings at 10 and 2 minutes left, then a grace period (5 min) with a countdown in the control room, then the server ends the stream through the engine. Credits added during grace pay for the grace minutes and the show continues. Suspension by CoGolfers ends a live broadcast at once.
- **Wallet:** `org_billing.balance_cc` (hundredths of a credit) changes only together with a `wallet_tx` row in one transaction. Purchases are idempotent by Cashfree order id.
- **Payments:** Cashfree hosted checkout. The server creates the order, the app opens `/pay/<id>`, Cashfree returns to `/pay/<id>/done` and calls the webhook; credits are added only after `GET /pg/orders/{id}` reports `PAID` for the same amount.
- **Prices** live in the database (`platform_settings`, per-club `overrides`) and are edited in `/admin`, so no redeploy is needed to change them.

## Replays and clips

MediaMTX records every camera continuously in 1-second fMP4 segments (retention `RECORDING_RETENTION`, default 72 h).

- **Instant replay:** the server asks the MediaMTX playback API for the last N seconds of a camera (optionally slowed to 50%), saves an MP4, and sends the agent a signed, short-lived URL. The agent plays it in **CG Replay** (with the REPLAY bug) and returns to the previous scene when it ends.
- **Highlight clips:** the same footage rendered twice with FFmpeg: 1920×1080 and 1080×1920 (blurred fill for Reels/Shorts), title burnt in, thumbnail. Shared with signed links valid 7 days.

Any camera can be replayed or clipped, on air or not.

## YouTube

The owner connects the club's channel once (Google OAuth, `youtube` scope, offline access). The refresh token is stored encrypted (AES-256-GCM, `DATA_KEY`). Per tournament the server creates a liveBroadcast (auto-start/auto-stop, low latency) and a liveStream, binds them, and the server's relay streams to that ingest (the key never leaves the server). It polls lifecycle and stream health and shows them in the app. Without any platform set up, laptop mode can still stream with a key set in OBS or the agent's `.env`.

## Failure handling

| Failure | Detected by | What happens |
|---|---|---|
| Phone loses network | SRT error on phone; MediaMTX path offline | Phone retries 1→8 s with jitter while the operator wants to be live; tile shows CONNECTING / NO SIGNAL |
| On-air camera drops | health poll | after 3 s the engine cuts to the fallback scene; directors get an alert (per-tournament switch) |
| iOS app backgrounded | AVCaptureSession interruption | feed shows PAUSED; resumes on return (see LIMITATIONS) |
| Scorer has no signal | request fails | scores stay queued on the phone (survive restarts) and send in order when signal returns |
| Commentator link drops | WebRTC connection state | reconnects with backoff; mixer shows the commentator offline |
| Agent or OBS down | WebSocket / obs-websocket close | ENGINE OFFLINE / OBS NOT REACHABLE; switching disabled; both reconnect |
| Cloud engine idle | no stream for `CLOUD_ENGINE_IDLE_STOP_MIN` | container stopped, directors informed |
| Server restart | WebSocket close | apps and agent reconnect and resubscribe |

## Security

- HTTPS/WSS via Caddy. JWT: accounts 12 h, volunteers 2 days, engine per tournament.
- Per-camera and per-commentator publish keys; per-tournament OBS read key, engine key and graphics key. Engine key can be rotated from the app.
- MediaMTX auth hook is deny-by-default: cameras may publish only SRT, commentators only WebRTC/SRT, reads need the engine key or a JWT with watch rights; API/playback are internal only.
- Secrets at rest (YouTube tokens) encrypted with `DATA_KEY`. Replay and clip URLs are HMAC-signed and expire.
- The cloud-engine driver uses the Docker socket; the server container runs as an unprivileged user with the host's docker group only when cloud mode is enabled.

## Bandwidth and cost (10 cameras, 5-hour event, YouTube + Facebook + Instagram)

Since V7 OBS sends a 720p programme at 2.5 Mbps (was 1080p at 6 Mbps), so the restream and director-preview figures below are about 60% lower; the watch player passes that programme straight through (see DEPLOYMENT §3m).

Rough figures to plan with; check your provider's current prices.

| Flow | Laptop mode | Cloud mode |
|---|---|---|
| Phones → VM (inbound, free) | ~26 Mbps | same |
| VM → OBS | ~26 Mbps out of the VM (~59 GB) | inside the VM: 0 |
| OBS → VM programme (inbound, free) | ~6 Mbps from the laptop | inside the VM |
| VM → YouTube + Facebook + Instagram | ~6 + 6 + 3.6 Mbps (~35 GB) | same |
| VM → director tablet | ~6 Mbps (~13 GB) | same |
| Public watch page | JSON only (video comes from YouTube) | same |
| VM compute | 2 vCPU / 4 GB + ~1 vCPU for the Instagram re-encode | + engine container ~6 vCPU / 6 GB while running |

On AWS Mumbai (ap-south-1) egress is about USD 0.11/GB: roughly USD 12 per event in laptop mode and USD 5 in cloud mode (plus the engine's compute hours, `CLOUD_ENGINE_COST_PER_HOUR`). With YouTube only, subtract about USD 2. Viewers on the watch page add nothing: YouTube streams to them.
