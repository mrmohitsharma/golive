# Deployment

Three pieces: the **server VM** (ingest, API, recording, optional cloud engines), the **broadcast engine** (laptop or cloud), and the **mobile app** ([MOBILE.md](MOBILE.md)).

## 1. Server VM

**Size:** laptop mode only: 2 vCPU / 4 GB. With cloud production: add ~6 vCPU / 6 GB per tournament that is live at the same time (e.g. an 8 vCPU / 16 GB VM for one cloud event, or a c6i.2xlarge-class instance). Ubuntu 24.04 with Docker. Pick a region near the course (India: Mumbai).

**Disk:** recordings for replays/clips use ~1.2 GB per camera-hour at 720p. 10 cameras × 5 h with 72 h retention ≈ 60 GB per event day kept. Plan 100–200 GB.

**DNS:** an A record, e.g. `live.cogolfers.com` → the VM's public IP.

**Firewall:**

| Port | Proto | Why |
|---|---|---|
| 80, 443 | TCP | HTTPS API, WebSocket, WebRTC signalling, graphics page (Caddy, Let's Encrypt) |
| 443 | UDP | HTTP/3 (optional) |
| 8890 | UDP | SRT: phones publish; a laptop OBS reads |
| 8189 | UDP | WebRTC media: director previews, commentary microphones |
| 8189 | TCP | WebRTC fallback when the viewer's network blocks UDP |

**Start:**

```bash
git clone <this repo> && cd cogolfer-live-director/infra
cp .env.example .env
nano .env          # PUBLIC_DOMAIN, PUBLIC_IP, and each secret: openssl rand -hex 32
docker compose up -d --build
docker compose logs -f server               # migrations, "listening"
curl https://live.cogolfers.com/healthz     # {"ok":true,"mediaServer":{"reachable":true},...}
curl https://live.cogolfers.com/api/info    # which features are enabled
```

`.env` reference (see comments in `infra/.env.example`):

| Setting | Purpose |
|---|---|
| `JWT_SECRET`, `DATA_KEY`, `MEDIAMTX_HOOK_SECRET`, `INTERNAL_MEDIA_PASS`, `POSTGRES_PASSWORD` | Secrets. `DATA_KEY` encrypts YouTube tokens: keep it stable (changing it disconnects YouTube) |
| `SIGNUP_ENABLED` | `true`: organisers create their own club in the app. `false`: closed server, create accounts with the CLI |
| `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` | First platform admin (created once) |
| `SRT_LATENCY_MS`, `SRT_PASSPHRASE` | SRT buffer (600 ms suits 4G) and optional AES |
| `RECORDING_RETENTION` | How long camera recordings are kept for replays and clips (default 72h) |
| `GOOGLE_CLIENT_ID/SECRET` | Enables **Connect YouTube** (section 3) |
| `META_APP_ID/SECRET` | Enables **Connect Facebook** (section 3b) |
| `PUBLIC_CORS_ORIGINS`, `WATCH_EMBED_ORIGINS` | Lets the CoGolfers website use the public API and embed the watch page (section 3d) |
| `INSTAGRAM_VIDEO_KBPS` | Bitrate of the 9:16 Instagram version (default 3500) |
| `CLOUD_ENGINE_*`, `DOCKER_GID` | Enables cloud production (section 4) |

**Accounts without the app** (closed servers, scripts):

```bash
docker compose exec server node dist/seed-cli.js signup owner@club.in "Owner" '<password>' "DLF Golf"
docker compose exec server node dist/seed-cli.js member <org-id> director@club.in director "Director" '<password>'
docker compose exec server node dist/seed-cli.js tournament <org-id> "Monsoon Open" "DLF Golf" laptop
docker compose exec server node dist/seed-cli.js joincode <tournament-id> camera "All cameras"
docker compose exec server node dist/seed-cli.js orgs
```

**Updates:** `git pull && docker compose up -d --build`. Migrations run on start.

## 2. Laptop mode (OBS at the course)

1. **OBS Studio 30+ from obsproject.com** (the official builds include the Browser Source needed for graphics). *Tools → WebSocket Server Settings*: enable, port 4455, set a password.
2. *Settings → Video*: 1920×1080, 30 fps. *Output*: hardware encoder (Apple VT / NVENC), CBR 6000–8000 kbps, keyframe 2 s.
3. **Node.js 22**, then:

```bash
cd cogolfer-live-director/agent
npm ci && npm run build
cp .env.example .env
```

4. In the app: *Tournament → Production → Engine setup (.env)* → **Copy** or **Share** and paste `SERVER_URL`, `TOURNAMENT_ID`, `ENGINE_KEY` into `.env`; add `OBS_PASSWORD`.
5. `npm start`. Expected:

```
connected to OBS 31.x (ws 5.x)
connected to server https://live.cogolfers.com
OBS scenes synced: 10 cameras (+10 new, 0 updated, -0 removed)
```

The agent creates and maintains: one scene per camera (`CG cam-xxxx`), `CG Fallback`, `CG Replay`, and the nested `CG Layers` scene (commentary + graphics) on top of each. Add your own logos/overlays freely; the agent only manages the `CG …` items. When any platform is set up in the app (YouTube, Facebook or Instagram), the agent points OBS at the server (one SRT stream, UDP 8890 outbound) and the server sends it on to each platform. Otherwise set `YOUTUBE_STREAM_KEY` or configure OBS → Stream yourself.

**Laptop sizing (10 cameras, 720p):** ~26 Mbps download, 6–10 Mbps upload; Apple Silicon or an RTX-class Windows laptop, 16 GB RAM. If the venue cannot sustain that, use cloud mode.

## 3. Connect YouTube (once per server)

1. Google Cloud Console → new project → *APIs & Services → Library*: enable **YouTube Data API v3**.
2. *OAuth consent screen*: External, app name "CoGolfer Live", your support email, scope `https://www.googleapis.com/auth/youtube`. Add your clubs' Google accounts as **test users** while the app is in Testing.
3. *Credentials → Create OAuth client ID → Web application*. Authorised redirect URI: `https://<PUBLIC_DOMAIN>/api/youtube/callback`.
4. Put the client ID and secret in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`), `docker compose up -d`.
5. In the app the club owner taps *Organisation (people icon) → Connect YouTube*, approves in the browser, returns to the app.

Notes:
- The channel must have live streaming enabled (YouTube Studio → Go live; the first activation can take 24 h; phone verification needed).
- While the Google app is in **Testing**, only listed test users can connect and refresh tokens expire after 7 days (reconnect weekly). For many clubs, submit the app for **verification** (the `youtube` scope is sensitive: privacy policy, homepage, demo video; typically a few weeks).
- API quota (default 10,000 units/day): creating a broadcast costs ~150 units; status is polled every 15 s only while a director has the control room open (~480 units/hour per event). That is about three 5-hour events per day **without** viewer comments; reading YouTube comments adds ~1,200 units/hour, so with comments on it is **one** 5-hour show a day (§3f). Raise `YOUTUBE_POLL_MS` / `YOUTUBE_CHAT_POLL_SEC` or request more quota in the console for more.

## 3b. Connect Facebook (once per server)

1. [developers.facebook.com](https://developers.facebook.com) → *My Apps → Create app*, type **Business**, name "CoGolfer Live".
2. Add the product **Facebook Login for Business** (or Facebook Login). *Settings*: Valid OAuth Redirect URI `https://<PUBLIC_DOMAIN>/api/facebook/callback`.
3. Permissions used: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_read_user_content` (viewer comments). While the app is in development only people with a role on the app (admins, developers, testers) can connect: add each club's Page admin as a tester. For any club to connect, request **Advanced Access** for those permissions through **App Review** (Meta may also ask for Business Verification).
4. *App settings → Basic*: copy the App ID and App Secret into `.env` (`META_APP_ID`, `META_APP_SECRET`), `docker compose up -d`. `/api/info` now shows `"facebook":true`.
5. In the app the owner taps *Organisation → Connect Facebook*, signs in as a Page admin, approves, and picks the Page if they manage several.

Facebook's own rules: the Page must be at least 60 days old with at least 100 followers to go live through the API.

## 3c. Instagram (before each event)

Instagram has no API for going live, so the director pastes a key each time:

1. On a computer, open instagram.com with the club's professional account → *Create (+) → Live video* → title and audience. (Live Producer is still "limited access": not every account has it yet.)
2. Copy **Stream URL** and **Stream key** into the app: *Tournament → Streaming platforms → Paste Instagram key*. The key changes every time.
3. Start the stream from the app as usual, then press *Go live* on instagram.com once the preview shows the picture.

Instagram receives a vertical 720×1280 version made on the server (full picture, blurred bars above and below). It needs about 1 vCPU while live (on a t3.large that is above its CPU baseline, billed as T3 Unlimited surplus).

## 3c-2. Several YouTube channels, Facebook or Instagram accounts (extra destinations)

One show can go to more places than the main YouTube channel, Facebook Page and Instagram key:

- **Another YouTube channel, connected:** Organisation owner or admin, in the app: event screen → *Streaming platforms* → *Add destination* → *Another YouTube channel* → *Connect a channel*. The channel's owner signs in with Google once. After that, adding it to an event makes the broadcast on that channel automatically; it starts and ends with the show.
- **Any channel or account by stream key:** *Add destination* → YouTube, Facebook, Instagram or *Other service*, then paste the stream key (and the URL for Instagram and other services). Nothing to connect.

Pricing (in `/admin` → Pricing & packs): **Free destinations per event** (default 1) and **Credits per extra destination** (default 50). Every place the event streams to counts, including the main YouTube, Facebook and Instagram. When an organiser adds one more than the event includes, the app offers to buy it for this event. Set *Free destinations* to 3 to keep the old behaviour (YouTube + Facebook + Instagram free).

Server sizing: each destination is one more outgoing stream (4–6 Mbps), and each Instagram-style vertical destination uses about one CPU core.

## 3d. Show it on the CoGolfers website

The CoGolfers website can stay on its own server: viewers' browsers load the video from YouTube and the scores from this server.

1. In `.env`: `PUBLIC_CORS_ORIGINS=https://cogolfers.com,https://www.cogolfers.com` and the same for `WATCH_EMBED_ORIGINS`; `docker compose up -d`.
2. Simplest: embed the ready-made page (the app's *Public watch page → Embed code* copies it):

```html
<iframe src="https://live.cogolfers.com/watch/<tournament-id>" style="width:100%;aspect-ratio:16/10;border:0"
        allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>
```

3. Or build your own design with the public API (no login, cached 5 s):

```js
const { tournaments } = await (await fetch('https://live.cogolfers.com/api/public/live')).json();
const live = tournaments.find((t) => t.live);              // live first
// live.youtube.embedUrl → <iframe src=…>; live.watchPage; live.facebookUrl
const d = await (await fetch(`https://live.cogolfers.com/api/public/tournaments/${live.id}`)).json();
// d.leaderboard [{position, name, club, category, toPar, thru}], d.clips [{title, thumbUrl, landscapeUrl, verticalUrl}]
```

Poll every 10–30 s. Tournaments with *Public watch page* off, archived ones, and clips a director hid are never returned.

## 3f. Viewer comments (YouTube + Facebook + watch page)

Nothing extra to install. The watch-page chat works as soon as the page is public. While a tournament is live the server also reads:
- **YouTube live chat**, through the club's connected channel. Each read costs **5 YouTube API units**; at the default every 15 s (`YOUTUBE_CHAT_POLL_SEC`) a 5-hour show uses about **6,000 units**, plus ~2,400 for the broadcast status checks: about **8,600 of the default 10,000/day**, so one show a day. **Before running daily events, ask Google for more quota** (Google Cloud console → YouTube Data API v3 → Quotas → apply for higher quota; free, takes days). If the quota runs out the control room shows *"YouTube API quota for today is used up"*; streaming carries on, only comment reading stops.
- **Facebook live comments**, through the connected Page, every 4 s (`FACEBOOK_COMMENTS_POLL_SEC`). This needs the permission **`pages_read_user_content`**: add it to the Meta app (and to App Review for other clubs). **Clubs that connected Facebook before this version must connect again** (Organisation → Facebook → Disconnect → Connect).

Per tournament (app → tournament → *Public watch page*): chat on/off and slow mode. Extra words to mask: `CHAT_BLOCKED_WORDS=word1,word2`.

## 3e. Billing, the admin panel and Cashfree

**Rules (defaults, all editable in /admin):** each tournament gets **2 cameras** and **10 live minutes** free. A 3rd camera onwards is bought *per tournament* (100 credits each). After the free minutes every started minute costs credits (5 per minute), counted only while live (Go live → End). Clubs pay from a **credit wallet**; credits are bought in **packs** priced in rupees. When credits run out the director is warned at 10 and 2 minutes left, the stream continues for a **5-minute grace period**, then ends. Grace minutes are charged only if credits arrive before the end.

**Admin panel:** `https://live.cogolfers.com/admin`. Sign in with a CoGolfers administrator account (the `BOOTSTRAP_ADMIN_EMAIL` account, or anyone added under *Admins*). There you can:
- **Pricing & packs:** set the free cameras/minutes, the camera and minute prices, the grace period, and the credit packs shown to clubs. **Set your real prices before onboarding clubs**: the defaults are placeholders.
- **Clubs:** balances, usage, payments (give the bootstrap "CoGolfers" organisation custom pricing, e.g. 20 free cameras and 0 per minute, if CoGolfers runs its own events); add or remove credits (with a reason, recorded with your email); custom pricing for one club (e.g. a school league at a lower rate, or 0 per minute for unlimited); suspend a club (it cannot go live, and a live broadcast ends).
- **Live now:** every live broadcast with cameras, minutes and credit left. **Payments:** every Cashfree order; *Check with Cashfree* if a club says money left but credits did not arrive.

**Cashfree (online payment):**
1. In the Cashfree merchant dashboard, take the **sandbox** App ID and Secret Key (Developers → API keys).
2. In `infra/.env`: `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_ENV=sandbox`; `docker compose up -d`. `/api/info` shows `"payments": true`.
3. Add the webhook in Cashfree (Developers → Webhooks, payment events): `https://live.cogolfers.com/api/payments/cashfree/webhook`.
4. Test: app → wallet icon → *Buy credits* → pay with Cashfree's sandbox test UPI/card → the app shows the new balance; /admin → Payments shows *Paid*.
5. Go live with real money: production keys, `CASHFREE_ENV=production`, whitelist the domain `live.cogolfers.com` in Cashfree if asked.

How a payment is trusted: the server credits a club **only after asking Cashfree** that the order is `PAID` for the right amount (from the return page, the webhook, or the app checking), and only once per order. A forged webhook or return URL cannot add credits.

Without Cashfree keys the app shows *Contact CoGolfers to add credits*, and staff add credits in /admin (e.g. after a bank transfer). To run with no limits at all: `BILLING_ENABLED=false`.

## 3g. Public website, sign-up and legal pages

The server also serves the public website at the domain root:

| Page | What it is |
|---|---|
| `/` | Landing page: animated control room, cost calculator, live prices (from `/api/public/pricing`) |
| `/signup`, `/login` | Create an account (same as **New club** in the app) and log in |
| `/account` | Credit balance, buy a credit pack through Cashfree, next steps |
| `/terms`, `/privacy` | Terms of service and privacy policy |
| `/delete-account` | Account and data deletion instructions (Google Play and Meta ask for this URL) |

Fill in the legal details in `.env`, then `docker compose up -d`:

```
BRAND_NAME=Go Live
SUPPORT_EMAIL=support@icca.co.in
LEGAL_ENTITY=<registered company name>
LEGAL_ADDRESS=<registered office address>
GRIEVANCE_OFFICER=<name of the person who answers complaints>
LEGAL_UPDATED=27 October 2026
PLAY_STORE_URL=<Play Store link, once published>
```

Anything left empty shows as a yellow **[set …]** marker on the legal pages, so nothing is invented. Have a lawyer read the terms and privacy policy before launch.

**Use these URLs in the reviews:**
- Google Cloud Console > OAuth consent screen: Application home page `https://<domain>/`, privacy policy `https://<domain>/privacy`, terms of service `https://<domain>/terms`. Authorised domain: your domain. Verify the domain in Google Search Console with the same Google account.
- Meta app settings > Basic: Privacy policy URL `https://<domain>/privacy`, Terms `https://<domain>/terms`, User data deletion: "Data deletion instructions URL" `https://<domain>/delete-account`.
- Google Play Console > App content: Privacy policy `https://<domain>/privacy`; Data safety > account deletion URL `https://<domain>/delete-account`.

What the policy promises, and the code that keeps the promise:
- Disconnecting YouTube deletes the stored token **and revokes it at Google** (`youtube.disconnect`).
- YouTube and Facebook comments copied into the combined chat are **deleted after 30 days** (`chat.purgePlatformComments`, runs every 6 hours).
- Replay recordings are deleted after `RECORDING_RETENTION` (72h). If you change it, update the privacy policy too.
- Camera streams: set `SRT_PASSPHRASE` so camera video is encrypted in transit, as the policy says.

To run a closed instance without the website, set `SITE_ENABLED=false`.

## 3h. Sign in with Google (app and website)

Organisers can sign up and log in with one tap. Only `openid email profile` are asked for, so this needs no extra Google review. In the same Google Cloud project as YouTube, **APIs & Services > Credentials > Create OAuth client ID**:

| Client | Settings |
|---|---|
| Web application | Authorised JavaScript origins: `https://<domain>` (the website button). Its client ID is also the app's `GOOGLE_WEB_CLIENT_ID`. |
| Android | Package name from `bootstrap.sh`, SHA-1 of the upload key **and** of the Play app-signing key (Play Console > App integrity). |
| iOS | Bundle ID from `bootstrap.sh`. Add `GIDClientID` and the reversed client ID URL scheme to `ios/Runner/Info.plist` (see the google_sign_in iOS setup). |

Then in `.env` (Web first), and build the app with the same Web ID:

```
GOOGLE_SIGNIN_CLIENT_IDS=<web>.apps.googleusercontent.com,<android>.apps.googleusercontent.com,<ios>.apps.googleusercontent.com
```

A Google sign-in with the email of an existing account links to that account. A new account has no organisation yet: the app home screen and the website `/account` page ask for its name.

## 3i. Join links open the app

A volunteer who taps a WhatsApp join link (or scans the poster with the phone camera) lands in the app with the code filled in. The server publishes the two files Android and iOS check:

```
ANDROID_PACKAGE=com.cogolfers.cogolfer_live
# Play Console > Test and release > App integrity > App signing: both SHA-256 fingerprints
ANDROID_CERT_SHA256=AA:BB:...,CC:DD:...
# Apple Developer > Membership: Team ID, then the iOS bundle id
IOS_APP_ID=ABCDE12345.com.cogolfers.cogolferLive
PLAY_STORE_URL=https://play.google.com/store/apps/details?id=com.cogolfers.cogolfer_live
APP_STORE_URL=https://apps.apple.com/app/id<number>
```

Check `https://<domain>/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` after `docker compose up -d`. Without the app, `/join/<code>` shows the store buttons and the code.

## 3j. SMS through MSG91 (reminders, prize codes, winners)

Until these are set, a test sender records every message in the outbox (`messages` table) and the log, so everything can be tested. Indian SMS needs DLT: register the company (entity ID), a sender ID (e.g. `GOLIVE`) and these templates (`{#var#}` = variable), then create a Flow in MSG91 for each and paste its ID:

| Setting | Template text |
|---|---|
| `MSG91_TEMPLATE_OTP` | `{#var#} is your Go Live code to claim your prize. Valid for 10 minutes. Do not share it.` |
| `MSG91_TEMPLATE_REMINDER` | `{#var#} is live now on Go Live. Watch: {#var#}` |
| `MSG91_TEMPLATE_WINNER` | `You won {#var#} in {#var#}! Claim within 24 hours: {#var#} - Go Live` |
| `MSG91_TEMPLATE_DRAW` | `You are in the {#var#} lucky draw. Winners announced at the end of the show - Go Live` |

```
MSG91_AUTH_KEY=<from MSG91 > API>
MSG91_TEMPLATE_OTP=...
MSG91_TEMPLATE_REMINDER=...
MSG91_TEMPLATE_WINNER=...
MSG91_TEMPLATE_DRAW=...
```

## 4. Cloud mode (OBS on the server)

```bash
cd infra
docker compose --profile build build cloud-engine     # builds cogolfer/cloud-engine (Ubuntu 24.04 + OBS PPA + agent)
getent group docker | cut -d: -f3                      # put this in DOCKER_GID
nano .env    # CLOUD_ENGINE_DRIVER=docker, CLOUD_ENGINE_CPUS/MEMORY_MB, IDLE_STOP_MIN, COST_PER_HOUR
docker compose up -d
curl https://live.cogolfers.com/api/info               # "cloudProduction": true
```

Directors then pick **Cloud** when creating a tournament (or under *Production*) and tap **Start cloud engine** ~5 minutes before the show. Each engine is one container on the compose network (`cg-engine-<id>`), reads cameras from MediaMTX internally, renders graphics from the server, and streams to YouTube. It stops when a director taps **Stop**, after `CLOUD_ENGINE_IDLE_STOP_MIN` minutes with nothing live, or after `CLOUD_ENGINE_MAX_HOURS`.

Engine defaults: 1920×1080 at 30 fps, 6000 kbps x264 `veryfast`, 2 s keyframes (`CLOUD_ENGINE_WIDTH/HEIGHT/FPS/VIDEO_KBPS`). That needs ~6 vCPU for the encode plus camera decoding (no GPU in a standard VM). On a smaller VM use 1280×720 / 4500 kbps.

**Important:** the Ubuntu OBS package's Browser Source availability varies by version. The engine reports *"This OBS has no Browser Source: graphics disabled"* in the control room if it is missing; switching, replays, commentary and YouTube still work. The image was not built in our test environment (no Docker Hub/Launchpad access) — build and run one test event before relying on it.

## 5. Event-day checklist

1. `/healthz` reachable. Laptop: agent shows *connected to OBS* and *connected to server*. Cloud: *Start cloud engine* → RUNNING, status bar shows OBS READY.
2. Course & players loaded; YouTube broadcast created (or created on *Go live*).
3. Volunteers: print or share the camera/scorer/commentator QR codes. Cameras: power banks; scan → name → GO LIVE. Tiles go LIVE within ~2 s.
4. Commentator: earphones on, *Start commentary*, check the meter in the Audio panel.
5. Director: preview → TAKE; check graphics (score bug, a lower third); try one replay.
6. Credits: the tournament's *Plan & credits* card shows enough camera slots and live time for the show (buy extra cameras before volunteers arrive).
7. Instagram: paste today's key. **Go live**; in the control room each platform pill turns LIVE within ~10 s. Check YouTube Studio, the Facebook Page and Instagram (press its *Go live*).
8. Pull one phone's network while on air: fallback within ~5 s, phone recovers by itself.

## Local development

```bash
# Postgres running locally; MediaMTX binary built or downloaded; ffmpeg on PATH
cd server && npm ci && TEST_DATABASE_URL=postgres://… npm test     # 74 tests
cd ../agent && npm ci && npm test                                    # 15 tests (fake OBS)
OBS_TEST_URL=ws://127.0.0.1:4455 OBS_TEST_PASSWORD=… node --import tsx --test test/obs-real.test.ts   # 6 tests, real OBS
MEDIAMTX_BIN=… DATABASE_URL=postgres://…/cg_live_e2e npm run e2e     # 29-step pipeline incl. real headless OBS and 3 restreams
tools/sim-camera.sh https://live.cogolfers.com K7Q-2MX "Hole 3 Tee" 3   # fake phone using a camera join code
```
