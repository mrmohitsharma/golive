# CoGolfer Live

Live multi-camera golf tournament broadcasts with phones, run by volunteers, streamed to YouTube, Facebook and Instagram at once, and shown on the CoGolfers website.

- **Cameras:** any Android or iPhone becomes a course camera (SRT, 720p/1080p, hole and position tagged).
- **Control room:** multiview, live preview/programme, TAKE / CUT, fallback, **instant replay** (incl. slow-mo), **graphics** (score bug, leaderboard, hole card, player lower third), **audio mixer** (commentary, ducking, per-camera levels, meters), **highlight clips** in 16:9 and 9:16.
- **Scoring:** volunteers enter hole-by-hole scores (works through dead spots); the leaderboard and graphics update live.
- **Commentary:** a volunteer talks over the broadcast from their phone (WebRTC) while watching what is on air.
- **Two production modes:** OBS on a **laptop** at the course, or OBS in the **cloud** started and stopped per event from the app.
- **Self-serve:** an organiser signs up with their club, invites staff, connects YouTube and Facebook once; volunteers join by **QR code without accounts**; each tournament creates its own YouTube broadcast and Facebook live video.
- **Multistreaming:** OBS sends one stream; the server sends it to **YouTube**, the club's **Facebook Page** and **Instagram** (as a 9:16 vertical version), each reconnecting on its own.
- **Billing and admin:** 2 cameras and 10 live minutes free per tournament; clubs buy extra cameras and live minutes with credits (Cashfree: UPI, cards, net banking). CoGolfers staff set prices, credit packs, per-club pricing and suspensions in the **/admin** panel.
- **Viewer comments:** one live chat on the CoGolfers watch page that also shows YouTube and Facebook comments; commentators read out questions, directors moderate and put a question on air.
- **Watch page + public API:** `/watch/<tournament>` with the YouTube player, live leaderboard, live chat and clips, embeddable in the CoGolfers website; video is carried by YouTube, so viewers cost nothing.

```
Volunteer phones ──SRT / WebRTC──▶ MediaMTX + server (cloud VM) ◀──▶ OBS + agent (laptop or cloud)
  camera · scorer · commentator         recording · replays · clips        one programme stream back
                                        relays ──▶ YouTube · Facebook Page · Instagram (9:16)
Director tablet ◀──WSS / WebRTC──▶ server ──JSON──▶ /watch page, CoGolfers website (YouTube player embedded)
```

## Repository

| Path | What |
|---|---|
| `mobile/` | Flutter app (Android, iOS). `mobile/packages/cg_streamer`: native SRT camera plugin (Kotlin + RootEncoder, Swift + HaishinKit) |
| `server/` | Node/TypeScript API, real-time hub, MediaMTX auth hook, scoring, graphics overlay, replays/clips, YouTube + Facebook, restream relays, public watch page/API, cloud engines. Postgres |
| `agent/` | Runs next to OBS (laptop or cloud container): scenes, switching, commentary mix, graphics layer, replays, meters. Includes the end-to-end test |
| `infra/` | `docker-compose.yml` (Postgres, server, MediaMTX, Caddy), `mediamtx.yml`, `Caddyfile`, `cloud-engine/` (OBS container) |
| `tools/sim-camera.sh` | Fake phone camera (FFmpeg) that joins with a camera code |
| `docs/` | [Architecture](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOYMENT.md) · [Mobile](docs/MOBILE.md) · [Protocol & API](docs/PROTOCOL.md) · [Testing](docs/TESTING.md) · [Known limitations](docs/LIMITATIONS.md) |

## Quick start

1. **Server:** `cd infra && cp .env.example .env && docker compose up -d --build` ([details](docs/DEPLOYMENT.md#1-server-vm)). Set prices at `/admin` ([§3e](docs/DEPLOYMENT.md#3e-billing-the-admin-panel-and-cashfree)). Optional: YouTube ([§3](docs/DEPLOYMENT.md#3-connect-youtube-once-per-server)), comments ([§3f](docs/DEPLOYMENT.md#3f-viewer-comments-youtube--facebook--watch-page)), Facebook ([§3b](docs/DEPLOYMENT.md#3b-connect-facebook-once-per-server)), Instagram ([§3c](docs/DEPLOYMENT.md#3c-instagram-before-each-event)), CoGolfers website ([§3d](docs/DEPLOYMENT.md#3d-show-it-on-the-cogolfers-website)), cloud production ([§4](docs/DEPLOYMENT.md#4-cloud-mode-obs-on-the-server)).
2. **App:** `cd mobile && ./tool/bootstrap.sh && flutter run` ([details](docs/MOBILE.md)). *New club* → create a tournament → add course and players → create join codes.
3. **Engine:** cloud mode: *Start cloud engine*. Laptop mode: OBS 30+ with WebSocket, then `cd agent && npm ci && npm run build`, paste the *Engine setup (.env)* from the app, `npm start`.
4. **Event:** volunteers scan the QR codes; director previews, TAKEs, adds graphics, replays, and taps **Go live**.

## Status

| | Status |
|---|---|
| Server | 74/74 tests |
| OBS agent | 15/15 (fake OBS) and 6/6 against real OBS Studio |
| End to end | 33/33: sign-up → admin pricing and credits → join codes → cameras (3rd needs a bought slot) → cloud OBS → one stream relayed to YouTube, Facebook and Instagram (switching verified on each output, Instagram 720×1280) → scoring → graphics → replay → clips → commentary + mixer → fallback → public watch page → stop → live minutes charged → comments from watch page, YouTube and Facebook in one feed, question on air |
| Mobile (Flutter, Kotlin, Swift) | Written and syntax-checked; **not compiled here** (no toolchains); needs a first device build |
| Not tested here | Real YouTube/Facebook/Instagram, Google/Meta logins and Cashfree sandbox, physical phones, the cloud-engine Docker image. See [LIMITATIONS](docs/LIMITATIONS.md) |

Licences of main dependencies: RootEncoder (Apache-2.0), HaishinKit (BSD-3-Clause), MediaMTX (MIT), OBS Studio (GPL-2.0, run as a separate program), obs-websocket-js (MIT), flutter_webrtc (MIT), mobile_scanner (BSD-3-Clause), share_plus / url_launcher (BSD-3-Clause).
