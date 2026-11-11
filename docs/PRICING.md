# Pricing (V9 simple plan)

One live rate, extras that charge themselves per minute while they are switched on, one-off add-ons, and welcome credits. Everything is in credits (1 credit = ₹1 at the Starter pack, plus 18% GST). Every value is editable in **Admin → Money → Pricing & packs**, and per club on the club page.

Switch to it with **Use the simple plan**, check the values, then **Save prices**. Until then the server keeps the prices already saved.

| Step | What | Simple plan | Setting |
|---|---|---|---|
| 1 | Go live: 2 cameras + 1 destination included | 6 / min | `minutePrice`, `freeCameras`, `freeDestinations`, `freeMinutes` (0) |
| 2 | Each extra camera, while it sends video live | 2 / min | `cameraMinutePrice` (0 = one-off slots, `cameraPrice`) |
| 2 | Each extra destination, while live | 1 / min | `destinationMinutePrice` (0 = one-off slots, `destinationPrice`) |
| 3 | Viewers on our watch page and embeds | 0.1333 / viewer-minute (8 / viewer-hour) | `viewerMinutePrice`, tiers off (`viewerTier2From` = `viewerTier3From` = 0) |
| 3 | YouTube and Facebook viewers | Free | `chargeSocialViewers` = no |
| 4 | Branding: logo, watermark and ticker (one purchase covers all three) | 199 per event | `brandingPrice`, `tickerPrice` |
| 4 | Influencers & games, 500 SMS included | 499 per event, then 1 per SMS | `viewershipPrice`, `viewershipMessages`, `messagePrice` |
| 4 | UPI QR: the organiser's own QR on the video (bottom right) and the watch page; money goes straight to them | 99 per event | `upiQrPrice` |
| 5 | Welcome credits for a new club | 300 once | `welcomeCredits`, `welcomeViewerMinutes` (0) |
| – | Gift credits | 15% of each gift | Admin → Gifts & payouts |

How charging works:
- **Live time:** charged per started minute from Go live to End stream.
- **Extras:** fractions of a credit accrue each meter pass and are charged on one growing wallet line per broadcast. Nothing needs to be bought first: an extra camera costs nothing while it isn't sending video.
- **When credits run out:** live time, extras and viewers share the same warnings (10 and 2 minutes left) and grace period. Anything unpaid when the show ends is written off.
- **In the control room:** it shows "credits/min now" while live, and the Go live confirmation lists the rates.

## Cost basis (estimates, November 2026)

AWS Mumbai egress is about $0.11/GB. Bunny CDN Asia is $0.03/GB (Volume network $0.005/GB, not yet tested from India). The rupee rate used is ₹88 to the dollar.

| Piece | Our cost | Price | Price ÷ cost |
|---|---|---|---|
| Live hour, laptop OBS (2 cameras, 1 destination, preview) | ~₹80 | ₹360 | 4.5× |
| Extra camera hour (laptop OBS) | ~₹26 | ₹120 | 4.6× |
| Extra destination hour | ~₹12 | ₹60 | 5× |
| Watch-page viewer hour (Bunny Asia, 720p/480p mix) | ~₹2.1 | ₹8 | 3.8× |

Check against real numbers after the first events: Admin → System (cost by month) and Admin → Streaming (Bunny GB and cost).
