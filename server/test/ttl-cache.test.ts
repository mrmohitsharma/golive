import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/ttl-cache.js';

describe('TtlCache: hot public reads', () => {
  it('shares one load between callers that miss together, keeps it for the TTL, and drops on change', async () => {
    const c = new TtlCache();
    let loads = 0;
    const load = async () => { loads++; await new Promise((r) => setTimeout(r, 20)); return loads; };
    const all = await Promise.all(Array.from({ length: 50 }, () => c.get('view:a', 1000, load)));
    assert.equal(loads, 1, '50 viewers at once: one load');
    assert.ok(all.every((x) => x === 1));
    assert.equal(await c.get('view:a', 1000, load), 1);
    c.drop('view:*');
    assert.equal(await c.get('view:a', 1000, load), 2);
    // A failed load is not kept.
    await assert.rejects(c.get('bad', 1000, async () => { throw new Error('x'); }));
    assert.equal(await c.get('bad', 1000, async () => 'ok'), 'ok');
  });
});
