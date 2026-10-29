# Real-time protocol and APIs

Source of truth: `server/src/hub.ts`, `server/src/protocol.ts`, `server/src/routes/*.ts`.

## Authentication

| Who | How | Token |
|---|---|---|
| Account | `POST /api/auth/login` `{email,password}` or `POST /api/auth/signup` `{name,email,password,orgName}` | JWT (12 h) + `user` + `orgs[]` |
| Volunteer | `POST /api/join` `{code, deviceId, name}` | JWT scoped to one tournament and role (2 days) + `role`, `guest`, `tournament` |
| OBS agent | `POST /api/engine/token` `{tournamentId, engineKey}` | engine JWT for that tournament |

Send `Authorization: Bearer <jwt>` on REST and on the WebSocket `wss://<server>/ws` (or `?token=`). `GET /api/me` returns the principal (and orgs, or the guest's tournament). `GET /api/info` (no auth) says which features the server has: `signup`, `youtube`, `cloudProduction`, `cloudCostPerHour`.

## REST (main endpoints)

| Area | Endpoints |
|---|---|
| Organisations | `GET/POST /api/orgs` · `GET/POST /api/orgs/:id/members` · `PATCH/DELETE /api/orgs/:id/members/:userId` |
| YouTube connect | `GET /api/orgs/:id/youtube` · `POST /api/orgs/:id/youtube/connect` → `{url}` (open in browser) · `DELETE /api/orgs/:id/youtube` · `GET /api/youtube/callback` (Google redirect) |
| Facebook connect | `GET /api/orgs/:id/facebook` → `{enabled, connected, userName, pages[], pageId, pageName}` · `POST …/facebook/connect` → `{url}` · `PUT …/facebook/page` `{pageId}` · `DELETE …/facebook` · `GET /api/facebook/callback` |
| Platforms | `GET/PATCH /api/tournaments/:id/outputs` — `{youtube:{enabled}, facebook:{enabled}, instagram:{enabled?, streamUrl?, streamKey?, clear?}}` → `{relay, platforms:[{platform, configured, enabled, state: off·connecting·live·retrying, error, link, hint}]}` |
| More YouTube channels | `GET /api/orgs/:id/youtube/channels` → `{enabled, channels[{id ('main' or uuid), channelId, title, main}]}` · `POST …/youtube/channels/connect` → `{url}` (owner/admin; Google sign-in of the other channel) · `DELETE …/youtube/channels/:channelId` (revokes at Google; its event destinations go too) |
| Extra destinations | `GET /api/tournaments/:id/destinations` → `{outputs, billing}` · `POST …/destinations` `{kind:'channel', channelId, privacy?, label?}` or `{kind:'key', platform: youtube·facebook·instagram·other, streamUrl?, streamKey, label?, vertical?}` (201) · `PATCH …/destinations/:destId` `{enabled?, label?, streamUrl?, streamKey?, vertical?, privacy?}` · `DELETE …/destinations/:destId` — each returns `{outputs, billing}`. `outputs.destinations[]` = `{id, kind, platform, label, enabled, ready, channelId, privacy, vertical, hint, link, state, since, error}`. Adding or switching on beyond the included destinations → **402 `destination_limit`**; buy with `POST …/billing/destinations` `{count}` |
| Billing (club) | `GET /api/orgs/:id/billing` → `{enabled, balance, pricing, packs[], paymentsEnabled, suspended, details (owner), transactions[]}` · `PUT …/billing/details` `{name, phone, email, gstin}` (owner) · `POST …/billing/checkout` `{packId, phone?}` → `{payment, checkoutUrl}` · `GET /api/payments/:id` (status + balance) |
| Billing (tournament) | `GET /api/tournaments/:id/billing` → `{cameras{free, extra, limit, used, price}, destinations{free, extra, limit, used, price}, minutes{free, liveSeconds, billed, price, freeSecondsLeft, remainingSeconds|null}, grace{active, secondsLeft}, balance, canGoLive, reason}` · `POST …/billing/cameras` `{count}` (402 `insufficient_credits`). Camera registration over the limit: 402 `camera_limit` |
| Cashfree | page `GET /pay/:paymentId` (opens Cashfree checkout) · return `GET /pay/:paymentId/done` · webhook `POST /api/payments/cashfree/webhook` (signature `x-webhook-signature` = base64 HMAC-SHA256 of timestamp + body) |
| Admin (platform admins) | page `GET /admin` · `GET /api/admin/overview` · `GET/PUT /api/admin/settings` `{pricing, packs}` · `GET /api/admin/orgs[?q=]` · `GET /api/admin/orgs/:id` · `PATCH /api/admin/orgs/:id/billing` `{overrides, suspended, suspendedReason}` · `POST /api/admin/orgs/:id/credits` `{credits, note}` · `GET /api/admin/live` · `GET /api/admin/payments[?status=]` · `POST /api/admin/payments/:id/recheck` · `GET/POST /api/admin/admins` · `DELETE /api/admin/admins/:userId` |
| Chat (public) | `GET /api/public/tournaments/:id/chat?after=<id>&v=<version>` → `{enabled, slowSec, version, unchanged}` or `{…, messages[{id, source: watch·youtube·facebook, author, text, question, pinned, at}], hidden[ids], pinned}` · `POST …/chat/name` `{name}` → `{token, name}` · `POST …/chat` `{text}` with `Authorization: Bearer <chat token>` (errors `chat_name_needed`, `slow_mode`, `no_links`, `chat_off`, `chat_banned`) |
| Chat (staff) | `GET /api/tournaments/:id/chat?v=` (commentator+) → messages incl. `hidden`, `answered`, and `sources{youtube, facebook: {state: off·reading·error, error}}` · `PATCH /api/chat/:id` `{answered}` (commentator) `{hidden, pinned}` (director) · `POST /api/chat/:id/ban` · `POST /api/chat/:id/on-air` `{visible}` → Viewer question graphic. Tournament `PATCH` takes `chatEnabled`, `chatSlowSec` |
| Public (no login, CORS) | `GET /api/public/live` · `GET /api/public/tournaments/:id` · page `GET /watch[/:id]` |
| Tournaments | `GET /api/tournaments` (with `role`) · `POST /api/orgs/:id/tournaments` · `PATCH /api/tournaments/:id` (name, venue, autoFallback, archived, mode) · `GET /api/tournaments/:id/state` (same as WS snapshot) · `GET …/switch-log` |
| Join codes | `GET/POST /api/tournaments/:id/join-codes` · `DELETE …/join-codes/:code` · `GET …/join-codes/:code/qr.png` · public page `GET /join/:code` |
| Engine | `GET …/engine-setup` (`.env` text) · `POST …/engine-key/rotate` · `POST …/cloud-engine/start` · `POST …/cloud-engine/stop[?force=true]` |
| YouTube broadcast | `POST …/youtube/broadcast` `{title?, privacy}` · `DELETE …/youtube/broadcast` |
| Cameras | `POST …/cameras/register` → `camera`, `publish{srtUrl,latencyMs}` · `GET/PATCH/DELETE /api/cameras/:id` · `GET /api/cameras/:id/publish` · `POST …/rotate-key` · `GET …/thumbnail.jpg` |
| Commentary | `POST …/commentators/register` → `commentator`, `publish{whipUrl, bearer}` · `DELETE /api/commentators/:id` |
| Scoring | `GET/PUT …/holes` (`{preset:"par72"}` or `{holes:[{number,par,yardage}]}`) · `GET/POST …/players` (`{csv}` or `{players:[…]}`) · `PATCH/DELETE /api/players/:id` · `PUT …/scores` `{playerId, hole, strokes|null}` · `GET …/leaderboard[?category=]` |
| Graphics | `GET/PATCH …/graphics` · overlay page `GET /graphics/:tid?k=<graphicsKey>` · SSE `GET /api/graphics/:tid/events?k=` |
| Audio | `GET/PATCH …/audio` |
| Clips | `POST …/clips` `{cameraId, secondsBack, durationSec, title?}` (202) · `GET …/clips` · `GET/PATCH {public}/DELETE /api/clips/:id` · `POST /api/clips/:id/share` → signed URLs · `GET /api/clips/:id/{landscape.mp4,vertical.mp4,thumb.jpg}[?sig=]` |

Errors are `{"error":{"code","message"}}` with a human-readable message the apps show as-is.

### Onboarding (Phase 1, V6)

| Endpoint | Who | What |
|---|---|---|
| `GET /api/auth/config` | anyone | `{signupEnabled, google: {clientId} \| null}` |
| `POST /api/auth/google` `{idToken, orgName?}` | anyone | Sign in or up with a Google ID token; `newUser` true = no organisation yet |
| `POST /api/auth/handoff` | account | One-time QR (5 min) to sign the app in: `{code, url, expiresAt, qrSvg}` |
| `POST /api/auth/handoff/redeem` `{code}` | anyone | Exchanges the code once for a session |
| `GET /api/event-types` | anyone | Kinds of event with caption labels and whether golf scoring applies |
| `GET /api/tournaments/:id/invites` | director | Camera, scorer, commentator invites with `shareText` and `whatsapp` links (made if missing) |
| `PUT /api/tournaments/:id/youtube/source` `{source: org\|golive}` | director | Main YouTube stream on the organisation's channel or the Go Live channel |
| `PUT /api/tournaments/:id/youtube/key` `{streamKey?, streamUrl?, videoUrl?}` / `DELETE` | director | Stream with a key pasted from YouTube Studio |
| `POST /api/tournaments/:id/start-show` `{privacy?}` | director | Starts the cloud mixer and creates the YouTube broadcast if missing: `{done, problems, production, youtube}` |
| `POST /api/speedtest/upload` (octet-stream) | signed in | Upload test for camera setup: `{bytes}` |
| `GET /api/orgs/:id/onboarding` | member | Checklist: `{steps: {account, channel, cameras, test, live}, hasEvent, done}` |
| `GET/POST/PATCH/DELETE /api/admin/golive-channel[/connect]` | platform admin | The Go Live YouTube channel |
| `/.well-known/assetlinks.json`, `/.well-known/apple-app-site-association` | anyone | App Links / Universal Links for `/join/*` and `/app/login/*` |

`POST /api/tournaments/:id/cameras/register`: `name` is optional (the server names it `Cam N`). Events carry `eventType` and `profile`; `/api/info` adds `goliveChannel` and `googleSignIn`; the YouTube state adds `source` and `goliveAvailable`.

### Viewership engine (V6)

| Endpoint | Who | What |
|---|---|---|
| `POST /api/public/tournaments/:id/view` `{viewerKey?}` | watch page | Starts a view when the video first plays: `{token, viewerKey, watchedSec, streamClockSec, live, beatSec}` |
| `POST /api/public/view/beat` `{token, playingSec, unmutedSec}` | watch page | Every 30 s and on hide/close (sendBeacon, text/plain JSON accepted). At most 38 s per report |
| `GET /api/tournaments/:id/viewership` | director | Watching now, viewers, qualified (30 s+), bounced, returning, watch/live/replay minutes, unmuted rate, apps, YouTube's own count, per-minute series, and `playable` (can the page play the video) |

| `GET/POST /api/tournaments/:id/influencers`, `PATCH …/:iid`, `POST …/:iid/rotate-stats` | director / manage | Influencers: name, handle, platform, terms, PAN (encrypted); short link `/w/<event>/<slug>`, stats page `/i/<key>` |
| `GET /api/tournaments/:id/influencers/:iid/kit` | director | QR (SVG), short link and event text; the Studio draws the story and post images |
| `GET /api/tournaments/:id/influencers/stats` | director | Per influencer: taps, viewers, 30 s+, left <30 s, minutes, avg, unmuted, returning, reminders, arrival time, watching now; totals incl. share via links |
| `PATCH /api/tournaments/:id/viewership-settings` `{attributionDays, influencerBoard}` | manage | Credit window (first link wins), whether influencers see each other's totals |
| `GET /w/:event[/:slug]` | anyone | Link preview tags (og:title "<name> invites you…"), counts a tap (crawlers excluded), redirects to `/watch/<id>?r=<slug>` |
| `POST /api/public/tournaments/:id/remind` `{phone, consent: true, ref?}` | watch page | "Remind me": one per number; SMS when the stream starts |
| `GET /i/:key`, `GET /api/public/influencer/:key` | influencer | Their numbers, rank and (if allowed) the leaderboard |
| `GET /studio`, `/studio/:id` | organiser | Web Studio (login with the website account) |

| `GET/POST /api/tournaments/:id/moments`, `PATCH/DELETE …/:mid` | director / manage | Games: quiz, poll, prediction, spin (draw: step 4); clock `viewer` / `stream` / `director`, `atSec`, `repeatEverySec` × `repeatMax`, `openSec`, audience (all, unmuted, one influencer's viewers, new, returning), `lateJoin` |
| `POST …/moments/:mid/fire`, `POST …/moments/:mid/resolve {correctOption}` | director | Fire now for everyone watching; settle a prediction |
| `GET …/moments/report` | director | Per game: runs, shown, played (rate), closed, right %, answers, watch time after (players vs skippers) |
| `GET /api/public/tournaments/:id/moments` | watch page | Games (no right answers) and shared runs; cached 2 s |
| `POST /api/public/moments/:mid/seen {token, runKey, kind}`, `…/play {token, runKey, answer?}` | watch page | Shown/closed; play: server checks the run is open, the viewer clock got there, the audience, one play each, and decides the result (spin drawn server-side) |

Watch page order: one card at a time, director first, then stream, then viewer clock, with `moment_gap_sec` (default 60) between cards (director games skip the gap). Cards sit under the video, never over it. `runKey` = shared run id, or `v<n>` for a viewer's own n-th run.

Clocks: **viewer clock** = seconds this viewer actually watched (video playing, tab visible; continues on return). **Stream clock** = seconds since `tournaments.first_live_at` (first Go live; never reset). Viewers are anonymous (random browser id; only a salted hash of the /24 network is stored, to cap one network at `VIEW_NET_CAP` = 25).

## WebSocket

Every frame is JSON with a `type`. Server → any client: `hello`, `error {code,message}`, `pong`.

### Directors and staff (`subscribe {tournamentId}`)

Who receives what depends on capability: **direct** (owner, director), **watch** (+ commentator), **view** (+ scorer, camera).

| type | to | fields |
|---|---|---|
| `snapshot` | view+ | `tournament`, `role`, `leaderboard` (top 20), `serverTime`; watch+ also `cameras[]`, `commentators[]`, `engine`, `mediaServer`, `graphics`, `audio`, `production`, `youtube` |
| `cameras` | watch | `cameras[]`, `commentators[]`, `mediaServer` (every health poll) |
| `engine` | watch | engine state; `programmeCameraId` is confirmed by OBS; `replayActive`, `fallbackActive`, `streaming{…}`, `warnings[]` |
| `leaderboard` | view | `rows[]` (top 20) after every score |
| `graphics`, `audio`, `production`, `youtube` | direct | full state after each change (YouTube every 15 s while a director is connected) |
| `outputs` | direct | platform states (same shape as `GET …/outputs`) whenever a relay connects, goes live, retries or stops |
| `billing` | direct | tournament billing (same shape as `GET …/billing`) every meter tick while live and after purchases; also in `snapshot` for directors |
| `chat` | watch | nudge: the viewer comments changed; fetch `GET …/chat?v=` |
| `meters` | direct | `levels {obsInputName: peak dBFS}` ~4×/s |
| `clip` | direct | clip object on create and on each status change (`queued → processing → ready|failed`) |
| `alert` | direct | `level`, `message`, `at` |
| `command.result` | sender | `requestId`, `action`, `ok`, `error?` |

Director → server: `command {action, cameraId?, requestId, seconds?, slowmo?}` with `action` ∈ `preview`, `take` (no camera = current preview), `cut`, `fallback`, `replay` (5–60 s, `slowmo` = half speed), `stream.start`, `stream.stop`. `stream.start` fails with the billing reason when the club is suspended or has no live minutes left.

### Camera phone (`camera.join {cameraId}`)

← `camera.joined` / `camera.updated {camera}`, `camera.removed`, `tally {onAir, preview}`. → `telemetry {state, bitrateKbps, battery, charging, durationSec, appState, resolution, fps, thermal, error}`.

### OBS agent (`engine.hello`)

← `engine.config`: `mode`, `fallbackScene`, `replayScene`, `cameras[] {id, name, hole, sceneName, inputName, srtUrl}`, `commentators[] {inputName, srtUrl}`, `graphicsUrl`, `output {server, key}|null` (the server's SRT programme ingest when any platform is set up; null = keep OBS / `.env` settings), `audio`, `canvas` (cloud only).
← `engine.audio {audio}`; ← `command {id, action, cameraId, sceneName | url, durationSec, returnScene}` (`replay.play` for replays).
→ `engine.state {state}`, `engine.meters {levels}`, `command.result {id, ok, error?}`.

## MediaMTX auth hook

`POST /internal/mediamtx/auth?secret=…` for every action, deny by default:

| action | allowed when |
|---|---|
| publish | camera path: SRT only + that camera's publish key. Commentary path: WebRTC (WHIP, `Authorization: Bearer com:<key>`) or SRT + that commentator's key. Programme path `prog-<tournament id>`: SRT only + the tournament's output key |
| read | internal user; the tournament's read key (OBS); a JWT with **watch** for that tournament (WHEP previews) |
| api, metrics, playback, pprof | internal user only |

SRT stream IDs: `publish:<path>:cam:<key>` (phones), `read:<path>:engine:<readKey>` (OBS). `latency` is milliseconds in phone URLs, microseconds in OBS/FFmpeg URLs.
