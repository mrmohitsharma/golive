import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig, type Config } from '../src/config.js';
import { createDb, migrate, type Db } from '../src/db.js';
import { buildApp, type App } from '../src/app.js';
import type { CloudDriver } from '../src/cloud.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://cg:cg@127.0.0.1:5432/cg_live_test';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    DATABASE_URL: TEST_DB,
    JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    DATA_KEY: 'a'.repeat(64),
    PUBLIC_BASE_URL: 'https://live.example.com',
    MEDIAMTX_HOOK_SECRET: 'hook-secret-1234567890',
    INTERNAL_MEDIA_PASS: 'internal-pass-1234567890',
    PUBLIC_SRT_HOST: 'live.example.com',
    PUBLIC_WEBRTC_BASE: 'https://live.example.com/webrtc',
    THUMBNAIL_DIR: path.join(os.tmpdir(), `cg-thumbs-test-${process.pid}`),
    MEDIA_DIR: path.join(os.tmpdir(), `cg-media-test-${process.pid}`),
    THUMBNAILS_ENABLED: 'false',
    LOG_LEVEL: 'warn',
    AUTO_FALLBACK_GRACE_MS: '50',
    // Billing has its own tests; elsewhere, no camera or minute limits.
    BILLING_ENABLED: 'false',
    ...overrides,
  });
}

export async function resetDb(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export interface Harness {
  app: App;
  db: Db;
  config: Config;
  baseUrl: string;
  wsUrl: string;
  close: () => Promise<void>;
  setMediaPaths: (items: object[]) => void;
}

/** Starts the server on a random port with a fake MediaMTX API (and optional fakes for Google and cloud). */
export async function startHarness(
  opts: {
    env?: Record<string, string>;
    googleFetch?: typeof fetch;
    metaFetch?: typeof fetch;
    cloudDriver?: CloudDriver | null;
    relaySpawn?: Parameters<typeof buildApp>[0]['relaySpawn'];
    cashfreeFetch?: typeof fetch;
    msg91Fetch?: typeof fetch;
    billingClock?: () => number;
  } = {},
): Promise<Harness> {
  const config = testConfig(opts.env);
  const db = createDb(config.DATABASE_URL);
  await resetDb(db);
  let mediaItems: object[] = [];
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ itemCount: mediaItems.length, pageCount: 1, items: mediaItems }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  const app = await buildApp({
    config,
    db,
    startBackground: false,
    fetchImpl: fakeFetch,
    googleFetch: opts.googleFetch,
    metaFetch: opts.metaFetch,
    relaySpawn: opts.relaySpawn,
    cashfreeFetch: opts.cashfreeFetch,
    msg91Fetch: opts.msg91Fetch,
    billingClock: opts.billingClock,
    cloudDriver: opts.cloudDriver ?? null,
  });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.fastify.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    app,
    db,
    config,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    setMediaPaths: (items) => {
      mediaItems = items;
    },
    close: async () => {
      await app.fastify.close();
      await db.end();
    },
  };
}

export async function api(h: Harness, method: string, url: string, body?: unknown, token?: string) {
  const res = await fetch(h.baseUrl + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function expectOk<T = any>(p: Promise<{ status: number; body: any }>, ...statuses: number[]): Promise<T> {
  const r = await p;
  const ok = statuses.length ? statuses : [200, 201, 202, 204];
  if (!ok.includes(r.status)) throw new Error(`expected ${ok.join('/')} got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Self-serve sign-up: returns the owner's token and their organisation id. */
export async function signup(h: Harness, email: string, orgName = 'Test Golf Club') {
  const r = await expectOk(api(h, 'POST', '/api/auth/signup', { name: email.split('@')[0], email, password: 'password123', orgName }));
  return { token: r.token as string, orgId: r.orgs[0].id as string, userId: r.user.id as string };
}

export async function addStaff(h: Harness, ownerToken: string, orgId: string, email: string, role: string) {
  await expectOk(api(h, 'POST', `/api/orgs/${orgId}/members`, { email, role, name: email.split('@')[0], password: 'password123' }, ownerToken));
  const r = await expectOk(api(h, 'POST', '/api/auth/login', { email, password: 'password123' }));
  return r.token as string;
}

export async function createTournament(h: Harness, token: string, orgId: string, extra: Record<string, unknown> = {}) {
  const r = await expectOk(api(h, 'POST', `/api/orgs/${orgId}/tournaments`, { name: 'NCR Open', venue: 'DLF Golf', ...extra }, token));
  return r.tournament.id as string;
}

/** A volunteer scans the QR: create a join code and join with it. */
export async function joinAsGuest(h: Harness, managerToken: string, tournamentId: string, role: string, deviceId: string, name = 'Volunteer') {
  const c = await expectOk(api(h, 'POST', `/api/tournaments/${tournamentId}/join-codes`, { role }, managerToken));
  const j = await expectOk(api(h, 'POST', '/api/join', { code: c.code.code, deviceId, name }));
  return j.token as string;
}

export async function engineToken(h: Harness, tournamentId: string) {
  const t = await h.app.repo.tournamentById(tournamentId);
  const r = await expectOk(api(h, 'POST', '/api/engine/token', { tournamentId, engineKey: t!.engine_key }));
  return r.token as string;
}

/** WebSocket test client that buffers messages and lets tests await a type. */
export class TestSocket {
  private queue: any[] = [];
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(m);
      } else {
        this.queue.push(m);
      }
    });
  }
  static async open(url: string, token: string): Promise<TestSocket> {
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    const s = new TestSocket(ws);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    await s.next((m) => m.type === 'hello');
    return s;
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  next(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new Error(`timeout waiting for message; queued types: ${this.queue.map((q) => q.type).join(',')}`));
        }
      }, timeoutMs);
    });
  }
  type(t: string, timeoutMs?: number) {
    return this.next((m) => m.type === t, timeoutMs);
  }
  drain() {
    this.queue = [];
  }
  close() {
    this.ws.close();
  }
}
