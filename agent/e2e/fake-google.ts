import http from 'node:http';

/**
 * Stand-in for Google OAuth + YouTube Data API v3 for the end-to-end test. The ingest
 * address it hands out points at a local RTMP server ("fake YouTube"), so OBS's real
 * output can be pulled and inspected.
 */
export function startFakeGoogle(port: number, ingest: { server: string; key: string }, facebookIngest?: string) {
  let lifeCycleStatus = 'ready';
  const fb = { created: 0, ended: 0 };
  /** Viewer comments the test "posts" on YouTube and Facebook. */
  const chat = { youtube: [] as object[], facebook: [] as object[], ytReads: 0, fbReads: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    // ---------------- Facebook (Meta Graph API v26.0) ----------------
    if (url.pathname === '/fb/v26.0/dialog/oauth') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'fb-e2e-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname.startsWith('/graph/v26.0/')) {
      const p = url.pathname.slice('/graph/v26.0/'.length);
      const q = req.method === 'GET' ? Object.fromEntries(url.searchParams) : Object.fromEntries(new URLSearchParams(raw));
      if (p === 'oauth/access_token') {
        if (q.code === 'fb-e2e-code') return json(200, { access_token: 'fb-short' });
        if (q.fb_exchange_token === 'fb-short') return json(200, { access_token: 'fb-long' });
        return json(400, { error: { message: 'bad code' } });
      }
      if (p === 'me' && q.access_token === 'fb-long') return json(200, { name: 'E2E Page Admin' });
      if (p === 'me/accounts' && q.access_token === 'fb-long') return json(200, { data: [{ id: 'page-e2e', name: 'Gurgaon Golf Club', access_token: 'page-token' }] });
      if (p === 'page-e2e/live_videos' && q.access_token === 'page-token' && q.status === 'LIVE_NOW') {
        fb.created++;
        return json(200, { id: 'fb-live-1', secure_stream_url: facebookIngest });
      }
      if (p === 'fb-live-1/comments' && q.access_token === 'page-token') {
        chat.fbReads++;
        return json(200, { data: [...chat.facebook].reverse() });
      }
      if (p === 'fb-live-1' && req.method === 'GET') return json(200, { permalink_url: '/GurgaonGolf/videos/fb-live-1/' });
      if (p === 'fb-live-1' && q.end_live_video === 'true') {
        fb.ended++;
        return json(200, { id: 'fb-live-1' });
      }
      return json(400, { error: { message: `fake graph: no route ${req.method} ${p}` } });
    }

    // Consent screen: immediately "approve" and send the browser back with a code.
    if (url.pathname === '/auth') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'e2e-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const b = Object.fromEntries(new URLSearchParams(raw));
      if (b.grant_type === 'authorization_code' && b.code === 'e2e-code') {
        return json(200, { access_token: 'at-e2e', expires_in: 3600, refresh_token: 'rt-e2e', token_type: 'Bearer' });
      }
      if (b.grant_type === 'refresh_token' && b.refresh_token === 'rt-e2e') return json(200, { access_token: 'at-e2e', expires_in: 3600 });
      return json(400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer at-e2e') return json(401, { error: { message: 'Invalid Credentials' } });
    if (url.pathname === '/yt/channels') return json(200, { items: [{ id: 'UC-e2e', snippet: { title: 'CoGolfers E2E Channel' } }] });
    if (url.pathname === '/yt/liveBroadcasts' && req.method === 'POST') return json(200, { id: 'e2e-broadcast' });
    if (url.pathname === '/yt/liveStreams' && req.method === 'POST') {
      return json(200, { id: 'e2e-stream', cdn: { ingestionInfo: { streamName: ingest.key, ingestionAddress: ingest.server } } });
    }
    if (url.pathname === '/yt/liveBroadcasts/bind') return json(200, { id: 'e2e-broadcast' });
    if (url.pathname === '/yt/liveBroadcasts') return json(200, { items: [{ status: { lifeCycleStatus }, snippet: { liveChatId: 'e2e-chat' } }] });
    if (url.pathname === '/yt/liveChat/messages' && url.searchParams.get('liveChatId') === 'e2e-chat') {
      chat.ytReads++;
      return json(200, { items: chat.youtube, nextPageToken: `t${chat.youtube.length}`, pollingIntervalMillis: 1000 });
    }
    if (url.pathname === '/yt/liveStreams') return json(200, { items: [{ status: { streamStatus: 'active', healthStatus: { status: 'good' } } }] });
    json(404, { error: { message: 'not found' } });
  });
  return {
    server,
    listen: () => new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r())),
    setLifecycle: (s: string) => (lifeCycleStatus = s),
    facebook: fb,
    chat,
    close: () => server.close(),
  };
}
