import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import http from 'node:http';
import { Agent, type ObsConnector } from '../src/agent.js';
import { FakeObs } from './fake-obs.js';

/** A tiny fake of the CoGolfer server: engine-token endpoint + /ws. */
function fakeServer() {
  const received: any[] = [];
  const logins: any[] = [];
  let socket: WebSocket | null = null;
  let resolveConnected: () => void;
  const connected = new Promise<void>((r) => (resolveConnected = r));
  const server = http.createServer((req, res) => {
    if (req.url === '/api/engine/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b = JSON.parse(body);
        logins.push(b);
        res.setHeader('content-type', 'application/json');
        if (b.engineKey !== 'k'.repeat(48)) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { code: 'invalid_engine_key', message: 'bad key' } }));
        }
        res.end(JSON.stringify({ token: 'tok' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    assert.equal(req.headers.authorization, 'Bearer tok');
    socket = ws;
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    resolveConnected();
  });
  return {
    server,
    received,
    logins,
    connected,
    send: (m: object) => socket!.send(JSON.stringify(m)),
    waitFor: async (pred: (m: any) => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = received.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timeout; got ${received.map((m) => m.type).join(',')}`);
    },
    close: () => {
      wss.close();
      server.close();
    },
  };
}

describe('Agent with fake server and fake OBS', () => {
  const srv = fakeServer();
  const obs = new FakeObs();
  let agent: Agent;

  before(async () => {
    await new Promise<void>((r) => srv.server.listen(0, '127.0.0.1', () => r()));
    const port = (srv.server.address() as { port: number }).port;
    const connector: ObsConnector = { client: obs, connect: async () => {}, disconnect: async () => {} };
    agent = new Agent(
      {
        serverUrl: `http://127.0.0.1:${port}`,
        tournamentId: 't-1',
        engineKey: 'k'.repeat(48),
        obsUrl: 'ws://obs',
        youtubeServer: 'rtmps://yt',
        fallbackText: 'Back soon',
        stateIntervalMs: 100,
      },
      connector,
      () => {},
    );
    await agent.start();
    await srv.connected;
  });
  after(async () => {
    await agent.stop();
    srv.close();
  });

  it('logs in with the tournament engine key and reports OBS state', async () => {
    assert.deepEqual(srv.logins[0], { tournamentId: 't-1', engineKey: 'k'.repeat(48) });
    await srv.waitFor((m) => m.type === 'engine.hello');
    const st = await srv.waitFor((m) => m.type === 'engine.state' && m.state.obsConnected);
    assert.equal(st.state.studioMode, true);
  });

  it('syncs OBS from engine.config and executes a cut with confirmation', async () => {
    srv.send({
      type: 'engine.config',
      tournamentId: 't-1',
      tournamentName: 'T',
      mode: 'laptop',
      fallbackScene: 'CG Fallback',
      replayScene: 'CG Replay',
      cameras: [{ id: 'c1', name: 'Cam 1', hole: 1, position: null, streamPath: 'cam-1', sceneName: 'CG cam-1', inputName: 'CG cam-1 Feed', srtUrl: 'srt://x?streamid=read:cam-1:engine:k' }],
      commentators: [],
      graphicsUrl: null,
      output: null,
      audio: { courseDb: 0, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: true, commentaryDelayMs: 0 },
      canvas: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(obs.scenes.has('CG cam-1'));
    srv.send({ type: 'command', id: 'cmd-1', action: 'cut', cameraId: 'c1', sceneName: 'CG cam-1' });
    const res = await srv.waitFor((m) => m.type === 'command.result' && m.id === 'cmd-1');
    assert.equal(res.ok, true);
    await srv.waitFor((m) => m.type === 'engine.state' && m.state.programmeCameraId === 'c1');
  });

  it('applies audio messages and reports failures for unknown scenes', async () => {
    srv.send({ type: 'engine.audio', audio: { courseDb: -12, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: false, commentaryDelayMs: 0 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(obs.inputs.get('CG cam-1 Feed')!.volumeDb, -12);
    srv.send({ type: 'command', id: 'cmd-2', action: 'cut', cameraId: 'nope', sceneName: 'CG cam-404' });
    const res = await srv.waitFor((m) => m.type === 'command.result' && m.id === 'cmd-2');
    assert.equal(res.ok, false);
    assert.match(res.error, /No source/);
  });
});
