# Mobile app: build, configuration, use

One Flutter app (`mobile/`) for Android and iOS. What a person sees depends on their role: organiser/director, scorer, commentator or camera operator. Native capture and SRT publishing live in `mobile/packages/cg_streamer` (Kotlin / Swift). No WebView: camera preview is a native view, video monitors are native WebRTC renderers.

| | Android | iOS / iPadOS |
|---|---|---|
| Minimum OS | Android 7.0 (API 24) | iOS 15 |
| Camera / encode | Camera2 → MediaCodec H.264 + AAC (RootEncoder 2.8.1) | AVFoundation → VideoToolbox (HaishinKit 2.2.5) |
| Camera transport | SRT caller, MPEG-TS | SRT caller, MPEG-TS |
| Commentary | WebRTC (WHIP), Opus, echo cancellation | same |
| Screen off / background (camera) | keeps streaming (foreground service) | pauses (OS rule), resumes on return |

Packages: `flutter_webrtc` 1.6 (previews, commentary), `mobile_scanner` 7.4 (QR join), `url_launcher` 6.3 (YouTube connect, watch links, clips), `share_plus` 13.3 (invites, clips, engine .env), `shared_preferences`, `http`, `web_socket_channel`.

## Requirements

- Flutter **3.44+** (Dart 3.10+). iOS plugins build with Swift Package Manager (HaishinKit is SPM-only).
- Android: SDK platform 36, JDK 17, Android Gradle Plugin ≥ 8.12.1, Gradle ≥ 8.13 (`share_plus` 13). `bootstrap.sh` raises older template versions.
- iOS: Xcode 16+ on a Mac, your Apple Developer team.

## First build

```bash
cd mobile
./tool/bootstrap.sh        # flutter create scaffolding, iOS usage strings, AGP/Gradle check, pub get
flutter test               # unit + widget tests
flutter run -d <device>
```

`bootstrap.sh` never overwrites files in this repo. On macOS it writes `NSCameraUsageDescription` (camera + QR scanning) and `NSMicrophoneUsageDescription` (course audio + commentary). On Linux/Windows add both keys by hand before an iOS build.

**Android release:** `flutter build appbundle` (signing as in Flutter's guide). Permissions come from the plugin manifest: camera, microphone, internet, network state, wake lock, foreground service (camera + microphone), notifications. In the Play Console declare the camera/microphone foreground-service use ("live streaming a camera feed the user started").

**iOS release:** open `ios/Runner.xcworkspace`, set your team under Signing, `flutter build ipa`, upload to TestFlight. No background modes are declared (Apple does not allow background camera capture).

## Configuration

Nothing is baked into the app. The server address comes from the QR poster (or is typed once); everything else (SRT URLs, WebRTC URLs, keys) comes from the API per tournament.

Camera quality presets: 720p30 2.5 Mbps (default, 4G) · 720p25 1.5 Mbps (weak signal) · 1080p30 4.5 Mbps (strong 4G/5G, Wi-Fi) · 720p60 4 Mbps (swings). Android adapts bitrate under congestion.

## Using the app

**First screen** has three tabs:
- **Join** (volunteers): *Scan QR poster* (or type server + code), enter your name → straight into your job. No account.
- **Sign in**: organisers, directors, staff.
- **New club**: an organiser creates their account and club in one step (if the server allows sign-up).

**Organiser / director home:** organisation switcher, tournament list with your role, **New tournament** (name, venue, date, Laptop or Cloud production). Owners: people icon → staff (add by email, change roles), **Connect YouTube** and **Connect Facebook** (choose the Page).

**Credits** (wallet icon on the home screen, owners and directors): balance, what is free per tournament, *Buy credits* (opens Cashfree in the browser; the app shows the new balance when you come back), history. Owners also set the billing mobile/email/GSTIN.

**Tournament screen** (owner/director):
- Shortcuts: Control room · Scoring · Clips · Commentate · Use as camera.
- **Plan & credits:** cameras used of the limit with *Add camera* (bought for this tournament), live time left, club balance with *Buy credits*.
- **Production:** Laptop / Cloud. Laptop: *Engine setup (.env)* to copy/share to the OBS laptop, rotate key. Cloud: *Start / Stop cloud engine*, live run time and approximate cost.
- **YouTube:** create the broadcast (title, public/unlisted/private), status, Watch and Share link.
- **Streaming platforms:** switch YouTube, Facebook and Instagram on or off; *Paste Instagram key* (from instagram.com, before each event). While live, each shows LIVE / RETRYING.
- **Public watch page:** on/off, live chat on/off and slow mode, Open, Share link, and *Embed code* for the CoGolfers website.
- **Volunteers:** join codes per role with QR (tap for full screen to scan from your phone), share invite, copy link, revoke, optional expiry.
- **Course & players:** par-72 card in one tap then edit any hole; paste players from a spreadsheet (`Name, Club, Category, Group`).
- Settings: auto-fallback, archive.

**Control room:**
- Multiview tiles (thumbnails every 2 s), live PREVIEW and PROGRAMME monitors (WebRTC).
- Tap = preview, **TAKE**, tile **CUT** (or double-tap) = straight on air, **FALLBACK**.
- **REPLAY** under Programme: last 10 s of the on-air camera, then back automatically. Long-press for 8/15 s and slow motion (half speed, silent).
- Long-press a tile: replay that camera, slow-mo, save clip, rename/assign hole, remove.
- Tools row: **Comments** (the combined viewer comments; tap one to show it on air as a Viewer question, pin it on the watch page, hide it or block the author), **Graphics** (score bug, leaderboard rows/category, hole card auto/now, lower third from the leaderboard or custom text), **Audio** (commentary level/mute, ducking, commentary delay, course master, per-camera trim/mute, live meters), **Save clip**, **Clips**.
- Status bar: engine (laptop or cloud, with *Start cloud engine*), one pill per platform (YouTube / Facebook / Instagram: LIVE, RETRYING), live time left from credits (amber under 10 minutes, red countdown when credits are out; tap to buy), broadcast status, ingest, warnings. **Go live** creates the YouTube broadcast first if the club has connected YouTube, and the Facebook live video automatically.

**Camera operator:** name the camera, hole, position, quality, lens → **GO LIVE**. Green frame = in preview, red = on air.

**Scorer:** pick the hole (arrows or chips) and optionally your group. For each player: tap the box to enter par, −/+ to adjust, long-press to clear. Scores are saved on the phone first and sent in order; with no signal a banner shows how many are waiting and they go out automatically (also after the app restarts). Leaderboard tab.

**Commentator:** programme preview with what is on air, **Comments** tab (watch page + YouTube + Facebook in one list; *Questions* / *Not answered* filters; tap a question to mark it answered) and Leaderboard tab, **Start commentary**, Mute, live mic meter. Use earphones. Keep the screen open while talking.
