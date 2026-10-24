import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HealthPoller } from '../src/health.js';
import { sanitizeTelemetry } from '../src/hub.js';
import { testConfig } from './helpers.js';

describe('HealthPoller', () => {
  it('computes inbound kbps from byte deltas and handles old and new MediaMTX fields', async () => {
    let bytes = 0;
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          items: [
            { name: 'cam-new', online: true, onlineTime: '2026-01-01T00:00:00Z', inboundBytes: bytes, readers: [], tracks2: [{ codec: 'H264' }] },
            { name: 'cam-old', ready: true, readyTime: '2026-01-01T00:00:00Z', bytesReceived: bytes, readers: [{}, {}], tracks: ['H264'] },
          ],
        }),
      )) as unknown as typeof fetch;
    const p = new HealthPoller(testConfig(), () => {}, fetchImpl);
    await p.pollOnce();
    await new Promise((r) => setTimeout(r, 200));
    bytes = 75_000; // ~3 Mbit/s over 200 ms
    const snap = await p.pollOnce();
    assert.equal(snap.reachable, true);
    const n = snap.paths.get('cam-new')!;
    const o = snap.paths.get('cam-old')!;
    assert.equal(n.online, true);
    assert.equal(o.online, true);
    assert.equal(o.readers, 2);
    assert.ok(n.inboundKbps > 2000 && n.inboundKbps < 3200, `kbps ${n.inboundKbps}`);
  });

  it('reports MediaMTX as unreachable instead of throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    let ticks = 0;
    const p = new HealthPoller(testConfig(), () => ticks++, fetchImpl);
    const snap = await p.pollOnce();
    assert.equal(snap.reachable, false);
    assert.match(snap.error!, /ECONNREFUSED/);
    assert.equal(ticks, 1);
  });
});

describe('sanitizeTelemetry', () => {
  it('clamps values and drops unknown fields', () => {
    const t = sanitizeTelemetry({ state: 'live', battery: 140, bitrateKbps: -5, appState: 'weird', evil: 'x', error: 'e'.repeat(500) });
    assert.equal(t.state, 'live');
    assert.equal(t.battery, 100);
    assert.equal(t.bitrateKbps, 0);
    assert.equal(t.appState, null);
    assert.equal((t as any).evil, undefined);
    assert.equal(t.error!.length, 200);
    assert.equal(sanitizeTelemetry({ state: 'hacked' }).state, 'idle');
  });
});
