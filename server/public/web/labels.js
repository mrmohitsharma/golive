// Plain-language labels shared by admin pages.
// In the order a club meets them (V9 simple pricing first). `chargeSocialViewers` is yes/no.
export const PRICING_LABELS = {
  minutePrice: '1 · Credits per live minute',
  freeMinutes: '1 · Free live minutes per event',
  freeCameras: '1 · Cameras included',
  freeDestinations: '1 · Destinations included',
  graceMinutes: '1 · Grace minutes when credits run out',
  cameraMinutePrice: '2 · Credits per minute, each extra camera while live (0 = slots)',
  destinationMinutePrice: '2 · Credits per minute, each extra destination while live (0 = slots)',
  viewerMinutePrice: '3 · Credits per viewer-minute',
  chargeSocialViewers: '3 · Also charge YouTube and Facebook viewers',
  viewerTier2From: '3 · Tier 2 from (viewer-minutes per event, 0 = none)',
  viewerTier2Pct: '3 · Tier 2 price (% of the viewer-minute price)',
  viewerTier3From: '3 · Tier 3 from (viewer-minutes per event, 0 = none)',
  viewerTier3Pct: '3 · Tier 3 price (% of the viewer-minute price)',
  brandingPrice: '4 · Branding: logo, watermark and ticker, per event',
  tickerPrice: '4 · Ticker on its own (also turns on branding), per event',
  viewershipPrice: '4 · Influencers & games add-on (credits)',
  viewershipMessages: '4 · SMS included with the add-on',
  messagePrice: '4 · Credits per extra SMS',
  upiQrPrice: '4 · UPI QR on the video and watch page, per event',
  welcomeCredits: '5 · Welcome credits for a new club',
  welcomeViewerMinutes: '5 · Free viewer-minutes for a new club',
  cameraPrice: '6 · Credits per extra camera slot (when per-minute is 0)',
  destinationPrice: '6 · Credits per extra destination slot (when per-minute is 0)',
};
export const BOOL_PRICING = new Set(['chargeSocialViewers']);
export const TX_LABELS = {
  purchase: 'Credits bought', cameras: 'Extra cameras', minutes: 'Live minutes', admin: 'Admin adjustment', refund: 'Refund',
  destinations: 'Extra destinations', viewership: 'Influencers & games', messages: 'SMS', viewers: 'Viewer-minutes', branding: 'Branding', ticker: 'Branding', welcome: 'Welcome credits', upiqr: 'UPI QR',
};
export const ROLE_LABELS = { owner: 'Owner', director: 'Director', scorer: 'Scorer', commentator: 'Commentator', camera: 'Camera' };
export const FEATURE_LABELS = { cloud: 'Cloud OBS (OBS on our servers)', viewership: 'Influencers & games add-on' };
