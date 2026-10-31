# Bunny CDN watch player: developer to-do

Goal: the watch page plays the show with our own player. The server encodes 720p and 480p HLS, and viewers load it through Bunny CDN (`gogetslive.b-cdn.net`), not from our server. YouTube keeps working as an extra.

Branch: `v7-dev`. More detail: [DEPLOYMENT.md §3m](DEPLOYMENT.md).

**Already done in Bunny:**
- pull zone `gogetslive`, ID **6902506**;
- hostname `gogetslive.b-cdn.net`;
- origin `https://live.gogetslive.com`.

---

## 1. Finish the Bunny pull zone (dash.bunny.net → CDN → gogetslive)

- [ ] **Caching → General:**
  - *Cache expiration time* = **Respect origin Cache-Control**;
  - *Browser cache expiration* = **Match server cache expiration**.
- [ ] **Headers:**
  - turn on **Add CORS headers**;
  - make sure the extension list includes `m3u8, ts`.
- [ ] **Pricing tier:** Volume, to start with.
- [ ] **API key:** get the current one from Mohit, or reset it under *Account settings → API key*. The old one was shared in a chat.

## 2. Deploy `v7-dev` to live.gogetslive.com

- [ ] Before deploying, check the server has **at least 4 CPU cores** and **50 GB free disk**:
  - each live event uses well under 1 core while live (the agent makes OBS send 720p, which is passed straight through; only 480p is encoded);
  - recordings take about 1.6 GB per hour and are kept 14 days.
- [ ] Add these lines to `infra/.env` on the server. **Never commit the key to git.**
  ```
  HLS_ENABLED=true
  CDN_HOST=gogetslive.b-cdn.net
  BUNNY_PULL_ZONE_ID=6902506
  BUNNY_API_KEY=<the key>
  ```
- [ ] Deploy:
  ```
  cd infra
  git fetch && git checkout v7-dev && git pull
  docker compose up -d --build
  docker compose logs -f server
  ```
  Wait for "listening". Migrations 020–022 run on their own.

## 2b. Build the phone app (V7 changes)

- [ ] `cd mobile && flutter analyze && flutter test`. The app changes for the watch player were written without a Flutter SDK, so fix anything these report.
- [ ] Build and install on one Android phone and one iPhone. On an event, check:
  - Streaming platforms shows **Watch page player** with a switch;
  - the control room shows a **WATCH PAGE** pill;
  - with YouTube switched off, Go live reads **"Go live on the watch page"** and doesn't ask to create a YouTube broadcast.
- [ ] Update the **agent** on every OBS laptop to the `v7-dev` build. It sets OBS to 720p at 2500 kbps itself.

## 3. Check the setup

- [ ] Log in as a platform admin at `https://live.gogetslive.com/web/admin/streaming`.
- [ ] The page should show the hostname, zone `6902506` and the key's last 4 characters. Set the price to **Bunny Volume**, then click **Save**.
- [ ] Click **Test the setup**. All lines must say **OK**:
  - Player
  - Pull zone (Volume network)
  - Origin = `https://live.gogetslive.com`
  - Through the CDN
- [ ] Quick manual check: `curl -i https://gogetslive.b-cdn.net/hls/ping` should return `200 ok`.

## 4. Test event (do this within Bunny's 14-day trial)

- [ ] Create a test event and make sure **Settings → Public watch page** is on.
- [ ] On **Streaming → Watch page player**, the status should read "Starts with the show".
- [ ] Go live with 1–2 phones. Within about 20 seconds the status should be **live**.
- [ ] Open `https://live.gogetslive.com/watch/<event-id>` on:
  - a laptop (Chrome);
  - an Android phone on 4G;
  - an **iPhone (Safari)**, which hasn't been tested yet.
- [ ] On each one, check:
  - [ ] video plays within 5 seconds;
  - [ ] "Tap for sound" works;
  - [ ] the LIVE button jumps back to live;
  - [ ] the quality menu switches between 720p and 480p;
  - [ ] there's no buffering over 10 minutes on 4G.
- [ ] Open the browser's network tab. The `.ts` and `.m3u8` files must load from `gogetslive.b-cdn.net`, **not** from live.gogetslive.com.
- [ ] Copy the embed code from the Streaming tab into a test HTML page and check that it plays.
- [ ] End the show. Within a minute, a **Replay** should appear on the Streaming tab and the watch page should play it.
- [ ] Watch the server's CPU during the show (`docker stats`). Note the peak. With the V7 agent, the watch player should use well under 1 core: OBS sends 720p and the server only adds 480p.
- [ ] On the laptop, check OBS: Settings → Video → *Output (scaled) resolution* is 1280×720, and Output → Streaming bitrate is 2500. The agent sets these itself in Simple output mode.

## 5. Choose the network and report back

- [ ] If the Volume network buffers in India:
  1. switch the pull zone to **Standard** (with only Asia and other needed regions on);
  2. set the price in Admin → Streaming to "Bunny Standard (Asia)";
  3. test again.
- [ ] Next day, check that Admin → Streaming shows the bandwidth (GB) and cost.
- [ ] Optional hardening:
  1. tick **Only the CDN may read the stream** and save;
  2. in Bunny, go to **Edge rules → Add**, choose "Set Request Header", header `X-Origin-Secret` with the value shown, matching all URLs;
  3. click **Test the setup** again.
- [ ] Send Mohit:
  - the test results for each device;
  - which network (Volume or Standard) was used;
  - peak CPU;
  - GB used and cost.

## If something fails

| Problem | Check |
|---|---|
| Test says "Origin" wrong | In Bunny, set the Origin URL exactly to `https://live.gogetslive.com` |
| "Through the CDN" fails | `curl https://live.gogetslive.com/hls/ping` should return `ok`. If that works, check the zone's hostname and edge rules. |
| Status stays "connecting" or "retrying" | `docker compose logs server`; the programme must reach MediaMTX, and the camera feed must have sound |
| Player says "Reconnecting…" | Is the event still live? Check that `master.m3u8` loads from the CDN URL in the network tab |
| Video loads from live.gogetslive.com, not b-cdn.net | `CDN_HOST` isn't set: check Admin → Streaming |
| Server CPU at 100% | Check the event's warnings: OBS on *Advanced output* (or an old agent) means the server re-encodes. Switch OBS Output to Simple, or set `HLS_LADDER=720:2500` (720p only), then restart |
| Stream shows 1080p / high bitrate | Update the agent on the laptop (V7 sets OBS to 720p at 2.5 Mbps by itself) |
