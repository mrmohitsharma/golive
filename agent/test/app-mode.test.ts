import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { Agent, type ObsConnector } from '../src/agent.js';
import { enableWs, readWsSettings, wsConfigFile } from '../src/obs-setup.js';
import { FakeObs } from './fake-obs.js';

const wait = async (pred: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
};

describe('Agent app: OBS remote control set up for you', () => {
  it('switches the WebSocket server on and keeps the password the next time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
    assert.equal(readWsSettings(dir), null);
    const a = enableWs(dir);
    assert.equal(a.enabled, true);
    assert.equal(a.port, 4455);
    assert.ok(a.password.length >= 12);
    const raw = JSON.parse(fs.readFileSync(wsConfigFile(dir), 'utf8'));
    assert.equal(raw.server_enabled, true);
    assert.equal(raw.first_load, false);
    // OBS had it off with its own password and another port: both kept.
    fs.writeFileSync(wsConfigFile(dir), JSON.stringify({ server_enabled: false, server_port: 4460, auth_required: true, server_password: 'Mind%40952' }));
    const b = enableWs(dir);
    assert.deepEqual(b, { enabled: true, port: 4460, authRequired: true, password: 'Mind%40952' });
    assert.deepEqual(readWsSettings(dir), b);
  });
});

describe('Agent app: runs the event the club picked, switches when it changes', () => {
  const auths: string[] = [];
  let sock: WebSocket | null = null;
  const server = http.createServer((_q, r) => {
    r.statusCode = 404;
    r.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    auths.push(String(req.headers.authorization));
    sock = ws;
  });
  let token = 'tokA';
  let reassigned = 0;
  let agent: Agent;

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const obs = new FakeObs();
    const connector: ObsConnector = { client: obs, connect: async () => {}, disconnect: async () => {} };
    agent = new Agent(
      { serverUrl: `http://127.0.0.1:${port}`, tournamentId: '', engineKey: '', obsUrl: 'ws://obs', youtubeServer: 'rtmps://yt', fallbackText: 'Back', stateIntervalMs: 100, tokenSource: async () => token },
      connector,
      () => {},
    );
    agent.onReassigned = () => reassigned++;
    await agent.start({ server: false });
  });
  after(async () => {
    await agent.stop();
    wss.close();
    server.close();
  });

  it('waits for an event, connects with its token, and follows a move to another event', async () => {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(auths.length, 0, 'no event yet: no server connection');
    agent.linkServer();
    await wait(() => auths.length === 1);
    assert.equal(auths[0], 'Bearer tokA');
    // The organiser picks this laptop for another event: the server drops it with 4002.
    token = 'tokB';
    sock!.close(4002, 'laptop reassigned');
    await wait(() => reassigned === 1);
    agent.linkServer();
    await wait(() => auths.length === 2);
    assert.equal(auths[1], 'Bearer tokB');
    // Taken off every event: disconnects and stays off.
    agent.unlinkServer();
    await wait(() => !agent.serverConnected);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(auths.length, 2);
  });
});
