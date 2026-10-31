# Known limitations

Read before event day. Nothing here is hidden behind "coming soon".

## Platform rules (cannot be fixed in code)

### iOS / iPadOS: no camera in the background or when locked
iOS suspends `AVCaptureSession` when the app leaves the foreground or the device locks; no background mode allows third-party video capture. The app keeps the screen awake, warns before going live, reports the feed as **PAUSED** to the control room the moment iOS interrupts, and resumes automatically on return. iPad Split View keeps the camera where iPadOS allows. Operator rule: keep the app open and the screen on; use Do Not Disturb.

Commentary on iPhone also stops if the app is backgrounded (no background audio mode is declared). Keep the commentary screen open.

### Android: background works, within rules
Streaming continues with the screen off (foreground service, "camera is live" notification). Swiping the app away stops it. Aggressive vendor battery savers (some Xiaomi/Oppo/Vivo/Samsung builds) can kill it: turn off battery optimisation for the app on camera phones.

## Product limitations

| Area | Limitation | Workaround / next step |
|---|---|---|
| Mobile build | The Flutter/Dart, Kotlin and Swift code was **not compiled in this environment** (no Flutter/Android/Xcode toolchains reachable). Dart files were syntax-checked and cross-checked against the server JSON and plugin APIs. | Expect small compile fixes on the first `flutter build`; none should be design-level. |
| Onboarding (Phase 1) app code | Google sign-in (`google_sign_in` 7), deep links (`app_links` 6) and the new screens were written without a Dart compiler. Google sign-in needs the OAuth clients (DEPLOYMENT 3h); links need `ANDROID_CERT_SHA256` / `IOS_APP_ID` and the iOS Associated Domains capability (3i). | Run `flutter analyze` and test on a real phone: Continue with Google, a WhatsApp join link, Start show. |
| Cloud engine image | Built from `infra/cloud-engine/Dockerfile` (Ubuntu 24.04 + OBS PPA). Not built here (Docker Hub/Launchpad unreachable); the same entrypoint script with OBS 30 was tested as a process. | Build it on the server and run one test event. |
| Graphics in Ubuntu's OBS | Some Ubuntu OBS builds lack the Browser Source. The engine then reports a warning in the control room; everything except graphics works. | Laptop: install OBS from obsproject.com. Cloud: use the OBS PPA (the Dockerfile does) and verify the warning is absent. |
| Ducking | Keyed to the first commentator only (OBS sidechain takes one source). With two commentators, the second does not duck course audio. | Fine for one main voice; phase 2: a commentary bus. |
| Commentary lip-sync | Commentators watch WebRTC (~0.5 s) while cameras reach OBS over SRT (~0.6–1 s). Small offsets are corrected with *Commentary delay*. | Set once per event by ear. |
| Slow-motion replays | Half speed, without audio. | — |
| Replays / clips | Need MediaMTX recording; footage older than `RECORDING_RETENTION` (72 h) is gone. Clip rendering takes 5–20 s per clip on a 2-vCPU VM. | Raise retention / VM size. |
| Preview audio | WebRTC cannot carry the phones' AAC, so the app's Preview/Programme monitors are silent. Programme audio is in OBS and on YouTube. | Commentators listen to their own voice + course via earphones on the venue feed if needed. |
| Multiview | Tiles are 2-second thumbnails, not live video (keeps 9+ cameras affordable on a tablet). | Monitors are live. |
| YouTube OAuth | Until the Google app is **verified**, only listed test users can connect and tokens expire after 7 days. | Submit for verification before onboarding many clubs (see DEPLOYMENT). |
| YouTube quota | Default 10,000 units/day: ~3 five-hour events without viewer comments, 1 with comments (status checks ~480/h + chat ~1,200/h at 15 s). | Request more quota. |
| Extra destinations | Each destination is one more stream out of the server (about the programme bitrate, 4–6 Mbps upload each), and each vertical (Instagram) destination re-encodes on about one CPU core. An event can have at most 10 extra destinations. Viewer comments are read only from the main YouTube channel and Facebook Page. Extra YouTube channels connected with Google sign-in are subject to the same Google verification limits as the main channel. | Size the server for the busiest event: e.g. 6 destinations ≈ 30 Mbps upload. |
| One engine per tournament | A second agent replaces the first. | Intentional. |
| Tokens on the phone | Stored in app preferences, not Keychain/Keystore. Volunteer tokens last 2 days and are scoped to one tournament. | Phase 2: secure storage. |
| Scoring | Stroke play per hole only; no handicaps, Stableford or match play; ties shown as T2 but not resolved by countback. | Matches the current CoGolfers League format (no handicap). |
| Instagram | No API: the director pastes a new stream key before every event and presses *Go live* on instagram.com. Live Producer is "limited access", so some accounts cannot use it yet. | — |
| Facebook | Until Meta grants Advanced Access (App Review), only people with a role on the Meta app can connect. Pages need 60+ days and 100+ followers. | Submit for App Review before onboarding clubs. |
| Restream delay | The relay adds a few seconds before a platform goes live (8.7 s measured for all three) and about a second of latency. | — |
| Instagram CPU | The 9:16 re-encode uses about 1 vCPU per live tournament on the server. | Turn Instagram off on a small VM, or lower `INSTAGRAM_VIDEO_KBPS`. |
| Watch page player | Needs the YouTube broadcast to allow embedding (set automatically) and a channel in good standing; some channels with restrictions cannot be embedded. Without YouTube the page shows scores and links only. | Use the Facebook link, or the YouTube link button. |
| Billing prices | The defaults (100 credits per extra camera, 5 per minute, packs ₹500/₹1000/₹5000) are placeholders. | Set real prices in /admin before onboarding clubs. |
| Cashfree | Written against Cashfree PG API 2025-01-01 and tested with a fake Cashfree; not yet run against the Cashfree sandbox. No invoices/GST receipts are generated (Cashfree sends the payment receipt). | Add sandbox keys and do one test purchase (DEPLOYMENT §3e). Invoicing is a next step if clubs need GST invoices. |
| Live minutes | Counted while the engine reports streaming. If the engine (OBS agent) loses its connection to the server, counting pauses even if OBS keeps streaming. | — (favours the club) |
| Admin rights | Removing someone's admin access is immediate in /admin; their app session keeps owner-level access to clubs until it expires (12 h). | Sign them out by rotating JWT_SECRET if urgent. |
| YouTube comments | Read with `liveChatMessages.list`, 5 quota units per read (~6,000 units for a 5-hour show at the default 15 s). YouTube's newer streaming method (`streamList`) has no documented web endpoint, so it is not used. | Request more quota; or raise `YOUTUBE_CHAT_POLL_SEC`. |
| Facebook comments | Needs `pages_read_user_content` (App Review for other clubs; clubs connected earlier must reconnect). The 50 newest are read every 4 s, so in a flood of more than ~12 comments/second some are missed. Facebook may hide the commenter's name for some accounts ("Facebook viewer"). | — |
| Chat | One-way: watch-page messages are not posted to YouTube/Facebook and staff cannot reply from the app. Viewers identify only by a typed name (anyone can type any name). | Phase 2: CoGolfers login for viewers. |
| Live previews in a browser | WebRTC needs port 8189 (UDP, or TCP as a fallback) open on the server, and `PUBLIC_IP` set to the server's public IP. If both are blocked by the viewer's network, previews stay on "Connecting"; a TURN server would be the next step. | Open both rules in the AWS security group. |
| Watch-page counts | Only people watching on our watch page are counted per viewer (influencer links, shares). People watching inside the YouTube app show only in YouTube's total. Counting is anonymous per browser: one person on two browsers counts twice; private windows count as new viewers. | Compare with YouTube's number in Reports. |
| Games and prizes | Prize games are run by the organiser, who must follow Indian promotion rules (no purchase needed, terms published). Meta does not allow requiring a share to win, so sharing is optional. | Publish prize terms in the Studio; get a legal check before big prizes. |
| SMS | Needs MSG91 with DLT-approved templates; until then the test sender only records messages. After the included messages, SMS stop when the wallet is empty (claim codes still go). | Approve the 4 DLT templates (DEPLOYMENT §3j). |
| Refunds | Refunds go through Cashfree to the original payment method (a few days). Payments added by hand (admin credits) are not refunded through the panel. Tested against a fake Cashfree, not yet the sandbox. | Do one sandbox refund before production. |
| GST invoices | Built for a single GSTIN; place of supply is the buyer's GSTIN state, or the seller's state when the buyer has no GSTIN. SAC and rate are settings, not advice. | Have your accountant check the first invoices. |
| Cost and margin | Estimates from the rates entered in Settings and the usage we measure; AWS and MSG91 bills are not read automatically. Usage is counted by the billing meter, so with billing off it is not recorded. | Compare with the real bills monthly. |
| Log in as | Support sessions last 1 hour and cannot reach admin pages; the admin's own access is checked on every request. | — |
| Web control room | Shows the program and preview cameras as WebRTC previews (video only, no program audio); other cameras as thumbnails every 5 s. Needs the same WebRTC ports as the app. | Use headphones on the commentary feed if needed. |
| Email | Needs SMTP settings (Admin > Email); without them emails are logged as not sent. Tested with a fake mail server only. Plain HTML emails, English only. | Set up SES (DEPLOYMENT §3l) and send a test. |
| Support tickets | Replies happen on the web; replying by email to a ticket email does not add to the ticket. Attachments: images and PDFs only, 5 × 5 MB. | Reply-to is your support inbox, so check it too. |
| Browser commentary | The web commentator uses the browser microphone over WHIP; tested against a simulated engine, not real MediaMTX. | Try it once before an event. |
| Watch player (HLS) | About 10–20 s behind live (2 s segments). With the V7 agent OBS sends 720p which is passed straight through (only 480p encoded, well under 1 core per event); older agents or OBS in Advanced output mode get the full encode (about 2 cores). The player pauses downloads in hidden tabs (after 30 s; background listening stops too) and after 40 minutes without interaction. Tested with real FFmpeg and in Chromium; not yet on iPhone Safari (native HLS) or through a real Bunny pull zone. The cost figures come from Bunny's statistics times the price set in Admin > Streaming. Viewers are not charged in credits yet. | One test event from India on the Volume and Standard networks. |
| Scorer conflicts | Two scorers entering the same player+hole: the last one received wins. | Assign one scorer per group. |

## Verification status

| Piece | Status |
|---|---|
| Server | Compiles; 187/187 tests (incl. billing, Cashfree with a fake gateway, admin, web app, emails with a fake mail server, support tickets, viewer comments with fake YouTube/Facebook). |
| OBS agent | Compiles; 15/15 tests with fake OBS; **6/6 against real OBS Studio 30** (headless). |
| Full pipeline | **33/33** with real MediaMTX, real OBS (started by the cloud-engine entrypoint), simulated phones, fake Google/Meta APIs. YouTube, Facebook and Instagram outputs verified by frame colour (and audio level on YouTube); Instagram size 720×1280. Billing: 3rd camera refused until bought, live minutes charged while on air and stopped after. Comments from the watch page, YouTube and Facebook in one feed; a question put on air. |
| Graphics overlay | Rendered and checked in Chromium at 1920×1080; not shown inside OBS here (Ubuntu's OBS lacked Browser Source). |
| Camera simulator | Tested against a live local server with a join code. |
| Mobile apps | Written, syntax-checked, not compiled or run on devices. |
| Real YouTube, Facebook and Instagram, real Google/Meta login, physical phones, cloud engine Docker image | **Not tested.** Follow the device plan in [TESTING.md](TESTING.md). |
