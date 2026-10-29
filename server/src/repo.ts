import type pg from 'pg';
import type { Db } from './db.js';
import type { OrgRole, GuestRole } from './auth.js';
import { joinCode, randomSecret } from './crypto.js';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  google_sub: string | null;
  is_platform_admin: boolean;
  disabled: boolean;
  created_at: Date;
}

export interface OrgRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface MembershipRow {
  org_id: string;
  org_name: string;
  role: OrgRole;
}

export type ProductionMode = 'laptop' | 'cloud';

export interface TournamentRow {
  id: string;
  org_id: string;
  name: string;
  venue: string | null;
  starts_on: string | null;
  read_key: string;
  engine_key: string;
  graphics_key: string;
  production_mode: ProductionMode;
  auto_fallback: boolean;
  archived: boolean;
  graphics: Record<string, unknown>;
  audio: Record<string, unknown>;
  cloud_engine: Record<string, unknown>;
  yt_broadcast_id: string | null;
  yt_stream_id: string | null;
  yt_stream_key_enc: string | null;
  yt_ingest_url: string | null;
  yt_privacy: string | null;
  yt_source: 'org' | 'golive' | 'key';
  event_type: string;
  first_live_at: Date | null;
  watch_slug: string | null;
  attribution_days: number;
  influencer_board: boolean;
  moment_gap_sec: number;
  prize_terms: string | null;
  prizes_per_viewer: number;
  output_key: string | null;
  outputs: TournamentOutputs;
  public_watch: boolean;
  fb_live_video_id: string | null;
  fb_stream_url_enc: string | null;
  fb_permalink: string | null;
  extra_cameras: number;
  extra_destinations: number;
  live_seconds: number;
  billed_minutes: number;
  grace_seconds: number;
  live_session_at: Date | null;
  chat_enabled: boolean;
  chat_slow_sec: number;
  created_at: Date;
}

/** Which platforms a tournament streams to. Secrets are sealed (Sealer) before storage. */
export interface TournamentOutputs {
  youtube?: { enabled?: boolean };
  facebook?: { enabled?: boolean };
  instagram?: { enabled?: boolean; urlEnc?: string | null; hint?: string | null };
}

export interface OrgFacebookRow {
  org_id: string;
  user_name: string;
  pages: { id: string; name: string; tokenEnc: string }[];
  page_id: string | null;
  connected_at: Date;
}

export interface CameraRow {
  id: string;
  tournament_id: string;
  name: string;
  hole: number | null;
  position: string | null;
  stream_path: string;
  publish_key: string;
  device_id: string;
  device_platform: 'android' | 'ios' | 'other' | null;
  device_model: string | null;
  owner: string;
  sort_order: number;
  last_telemetry: unknown;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CommentatorRow {
  id: string;
  tournament_id: string;
  name: string;
  stream_path: string;
  publish_key: string;
  device_id: string;
  owner: string;
  sort_order: number;
  created_at: Date;
}

export interface JoinCodeRow {
  code: string;
  tournament_id: string;
  role: GuestRole;
  label: string | null;
  created_at: Date;
  expires_at: Date | null;
  revoked: boolean;
  uses: number;
}

type Queryable = Db | pg.PoolClient;

export class CameraLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`camera limit ${limit}`);
  }
}

export class Repo {
  constructor(public readonly db: Db) {}

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(client);
      await client.query('COMMIT');
      return r;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- users & orgs
  async userCount(): Promise<number> {
    return Number((await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM users')).rows[0].n);
  }

  async userByEmail(email: string, q: Queryable = this.db): Promise<UserRow | null> {
    return (await q.query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1)', [email])).rows[0] ?? null;
  }

  async userById(id: string): Promise<UserRow | null> {
    return (await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1', [id])).rows[0] ?? null;
  }

  async createUser(
    u: { email: string; name: string; passwordHash: string | null; googleSub?: string | null; platformAdmin?: boolean },
    q: Queryable = this.db,
  ): Promise<UserRow> {
    return (
      await q.query<UserRow>(
        'INSERT INTO users (email, name, password_hash, google_sub, is_platform_admin) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [u.email.toLowerCase().trim(), u.name.trim(), u.passwordHash, u.googleSub ?? null, u.platformAdmin ?? false],
      )
    ).rows[0];
  }

  async userByGoogleSub(sub: string, q: Queryable = this.db): Promise<UserRow | null> {
    return (await q.query<UserRow>('SELECT * FROM users WHERE google_sub = $1', [sub])).rows[0] ?? null;
  }

  async linkGoogle(userId: string, sub: string, q: Queryable = this.db): Promise<UserRow> {
    return (await q.query<UserRow>('UPDATE users SET google_sub = $2 WHERE id = $1 RETURNING *', [userId, sub])).rows[0];
  }

  /** Records the first time an organisation reaches an onboarding step (no-op afterwards). */
  async markOnboarding(tournamentId: string, step: 'event' | 'camera' | 'test' | 'live'): Promise<void> {
    const col = { event: 'first_event_at', camera: 'first_camera_at', test: 'first_test_at', live: 'first_live_at' }[step];
    await this.db.query(`UPDATE orgs SET ${col} = now() WHERE id = (SELECT org_id FROM tournaments WHERE id = $1) AND ${col} IS NULL`, [tournamentId]);
  }

  async createOrg(name: string, q: Queryable = this.db): Promise<OrgRow> {
    return (await q.query<OrgRow>('INSERT INTO orgs (name) VALUES ($1) RETURNING *', [name.trim()])).rows[0];
  }

  async orgById(id: string): Promise<OrgRow | null> {
    return (await this.db.query<OrgRow>('SELECT * FROM orgs WHERE id = $1', [id])).rows[0] ?? null;
  }

  async addMember(orgId: string, userId: string, role: OrgRole, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, userId, role],
    );
  }

  async removeMember(orgId: string, userId: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rowCount ?? 0) > 0;
  }

  async memberships(userId: string): Promise<MembershipRow[]> {
    return (
      await this.db.query<MembershipRow>(
        `SELECT m.org_id, o.name AS org_name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id
         WHERE m.user_id = $1 ORDER BY o.created_at`,
        [userId],
      )
    ).rows;
  }

  async memberRole(orgId: string, userId: string): Promise<OrgRole | null> {
    return (
      (await this.db.query<{ role: OrgRole }>('SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2', [orgId, userId]))
        .rows[0]?.role ?? null
    );
  }

  async members(orgId: string) {
    return (
      await this.db.query<{ user_id: string; email: string; name: string; role: OrgRole; created_at: Date }>(
        `SELECT m.user_id, u.email, u.name, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 ORDER BY m.created_at`,
        [orgId],
      )
    ).rows;
  }

  async ownerCount(orgId: string): Promise<number> {
    return Number(
      (await this.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM org_members WHERE org_id = $1 AND role = 'owner'`, [orgId]))
        .rows[0].n,
    );
  }

  // ---------------------------------------------------------------- YouTube connection
  async orgYoutube(orgId: string) {
    return (
      (
        await this.db.query<{ org_id: string; channel_id: string; channel_title: string; refresh_token_enc: string; connected_at: Date }>(
          'SELECT * FROM org_youtube WHERE org_id = $1',
          [orgId],
        )
      ).rows[0] ?? null
    );
  }

  async saveOrgYoutube(orgId: string, v: { channelId: string; channelTitle: string; refreshTokenEnc: string; userId: string }) {
    await this.db.query(
      `INSERT INTO org_youtube (org_id, channel_id, channel_title, refresh_token_enc, connected_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, channel_title = EXCLUDED.channel_title,
         refresh_token_enc = EXCLUDED.refresh_token_enc, connected_by = EXCLUDED.connected_by, connected_at = now()`,
      [orgId, v.channelId, v.channelTitle, v.refreshTokenEnc, v.userId],
    );
  }

  async deleteOrgYoutube(orgId: string) {
    await this.db.query('DELETE FROM org_youtube WHERE org_id = $1', [orgId]);
  }

  // ---------------------------------------------------------------- tournaments
  async createTournament(t: {
    orgId: string;
    name: string;
    venue?: string | null;
    startsOn?: string | null;
    mode?: ProductionMode;
    eventType?: string;
    graphics?: object;
  }): Promise<TournamentRow> {
    return (
      await this.db.query<TournamentRow>(
        `INSERT INTO tournaments (org_id, name, venue, starts_on, production_mode, read_key, engine_key, graphics_key, output_key, event_type, graphics)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          t.orgId, t.name, t.venue ?? null, t.startsOn ?? null, t.mode ?? 'laptop',
          randomSecret(16), randomSecret(24), randomSecret(16), randomSecret(16),
          t.eventType ?? 'golf', JSON.stringify(t.graphics ?? {}),
        ],
      )
    ).rows[0];
  }

  async tournamentsForOrgs(orgIds: string[], includeArchived = false): Promise<TournamentRow[]> {
    if (!orgIds.length) return [];
    return (
      await this.db.query<TournamentRow>(
        `SELECT * FROM tournaments WHERE org_id = ANY($1::uuid[]) ${includeArchived ? '' : 'AND NOT archived'}
         ORDER BY created_at DESC`,
        [orgIds],
      )
    ).rows;
  }

  async tournamentById(id: string): Promise<TournamentRow | null> {
    return (await this.db.query<TournamentRow>('SELECT * FROM tournaments WHERE id = $1', [id])).rows[0] ?? null;
  }

  async updateTournament(
    id: string,
    patch: {
      name?: string;
      venue?: string | null;
      autoFallback?: boolean;
      archived?: boolean;
      mode?: ProductionMode;
      publicWatch?: boolean;
      chatEnabled?: boolean;
      chatSlowSec?: number;
      eventType?: string;
    },
  ): Promise<TournamentRow | null> {
    return (
      (
        await this.db.query<TournamentRow>(
          `UPDATE tournaments SET
             name = COALESCE($2, name),
             venue = CASE WHEN $3::boolean THEN $4 ELSE venue END,
             auto_fallback = COALESCE($5, auto_fallback),
             archived = COALESCE($6, archived),
             production_mode = COALESCE($7, production_mode),
             public_watch = COALESCE($8, public_watch),
             chat_enabled = COALESCE($9, chat_enabled),
             chat_slow_sec = COALESCE($10, chat_slow_sec),
             event_type = COALESCE($11, event_type)
           WHERE id = $1 RETURNING *`,
          [
            id,
            patch.name ?? null,
            patch.venue !== undefined,
            patch.venue ?? null,
            patch.autoFallback ?? null,
            patch.archived ?? null,
            patch.mode ?? null,
            patch.publicWatch ?? null,
            patch.chatEnabled ?? null,
            patch.chatSlowSec ?? null,
            patch.eventType ?? null,
          ],
        )
      ).rows[0] ?? null
    );
  }

  async setTournamentJson(id: string, column: 'graphics' | 'audio' | 'cloud_engine', value: object): Promise<void> {
    await this.db.query(`UPDATE tournaments SET ${column} = $2 WHERE id = $1`, [id, JSON.stringify(value)]);
  }

  async setYoutubeBroadcast(
    id: string,
    v: { broadcastId: string | null; streamId: string | null; streamKeyEnc: string | null; ingestUrl: string | null; privacy: string | null },
  ) {
    await this.db.query(
      `UPDATE tournaments SET yt_broadcast_id = $2, yt_stream_id = $3, yt_stream_key_enc = $4, yt_ingest_url = $5, yt_privacy = $6
       WHERE id = $1`,
      [id, v.broadcastId, v.streamId, v.streamKeyEnc, v.ingestUrl, v.privacy],
    );
  }

  /** Tournaments created before multistreaming have no output key yet. */
  async ensureOutputKey(t: TournamentRow): Promise<string> {
    if (t.output_key) return t.output_key;
    const key = randomSecret(16);
    const r = await this.db.query<{ output_key: string }>(
      'UPDATE tournaments SET output_key = COALESCE(output_key, $2) WHERE id = $1 RETURNING output_key',
      [t.id, key],
    );
    t.output_key = r.rows[0].output_key;
    return t.output_key;
  }

  async setOutputs(id: string, outputs: TournamentOutputs): Promise<TournamentRow | null> {
    return (await this.db.query<TournamentRow>('UPDATE tournaments SET outputs = $2 WHERE id = $1 RETURNING *', [id, JSON.stringify(outputs)])).rows[0] ?? null;
  }

  async setFacebookLive(id: string, v: { liveVideoId: string | null; streamUrlEnc: string | null; permalink: string | null }): Promise<void> {
    await this.db.query('UPDATE tournaments SET fb_live_video_id = $2, fb_stream_url_enc = $3, fb_permalink = $4 WHERE id = $1', [
      id,
      v.liveVideoId,
      v.streamUrlEnc,
      v.permalink,
    ]);
  }

  /** Non-archived tournaments listed on the public watch page. */
  async publicTournaments(): Promise<(TournamentRow & { org_name: string })[]> {
    return (
      await this.db.query<TournamentRow & { org_name: string }>(
        `SELECT t.*, o.name AS org_name FROM tournaments t JOIN orgs o ON o.id = t.org_id
          WHERE t.public_watch AND NOT t.archived ORDER BY t.starts_on DESC NULLS LAST, t.created_at DESC LIMIT 100`,
      )
    ).rows;
  }

  // ---------------------------------------------------------------- Facebook connection
  async orgFacebook(orgId: string): Promise<OrgFacebookRow | null> {
    return (await this.db.query<OrgFacebookRow>('SELECT * FROM org_facebook WHERE org_id = $1', [orgId])).rows[0] ?? null;
  }

  async saveOrgFacebook(orgId: string, v: { userName: string; pages: OrgFacebookRow['pages']; pageId: string | null; userId: string }) {
    await this.db.query(
      `INSERT INTO org_facebook (org_id, user_name, pages, page_id, connected_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET user_name = EXCLUDED.user_name, pages = EXCLUDED.pages, page_id = EXCLUDED.page_id,
         connected_by = EXCLUDED.connected_by, connected_at = now()`,
      [orgId, v.userName, JSON.stringify(v.pages), v.pageId, v.userId],
    );
  }

  async setOrgFacebookPage(orgId: string, pageId: string): Promise<void> {
    await this.db.query('UPDATE org_facebook SET page_id = $2 WHERE org_id = $1', [orgId, pageId]);
  }

  async deleteOrgFacebook(orgId: string): Promise<void> {
    await this.db.query('DELETE FROM org_facebook WHERE org_id = $1', [orgId]);
  }

  async rotateEngineKey(id: string): Promise<string> {
    const key = randomSecret(24);
    await this.db.query('UPDATE tournaments SET engine_key = $2 WHERE id = $1', [id, key]);
    return key;
  }

  async tournamentsWithCloudEngine(): Promise<TournamentRow[]> {
    return (await this.db.query<TournamentRow>(`SELECT * FROM tournaments WHERE cloud_engine ? 'id'`)).rows;
  }

  async tournamentsWithBroadcast(): Promise<TournamentRow[]> {
    return (await this.db.query<TournamentRow>('SELECT * FROM tournaments WHERE yt_broadcast_id IS NOT NULL AND NOT archived')).rows;
  }

  // ---------------------------------------------------------------- join codes
  async createJoinCode(tournamentId: string, role: GuestRole, label: string | null, createdBy: string | null, expiresAt: Date | null) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return (
          await this.db.query<JoinCodeRow>(
            `INSERT INTO join_codes (code, tournament_id, role, label, created_by, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [joinCode(), tournamentId, role, label, createdBy, expiresAt],
          )
        ).rows[0];
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
      }
    }
    throw new Error('could not allocate a join code');
  }

  async joinCodes(tournamentId: string): Promise<JoinCodeRow[]> {
    return (
      await this.db.query<JoinCodeRow>('SELECT * FROM join_codes WHERE tournament_id = $1 AND NOT revoked ORDER BY created_at', [tournamentId])
    ).rows;
  }

  async joinCode(code: string): Promise<JoinCodeRow | null> {
    return (await this.db.query<JoinCodeRow>('SELECT * FROM join_codes WHERE code = $1', [code])).rows[0] ?? null;
  }

  async useJoinCode(code: string) {
    await this.db.query('UPDATE join_codes SET uses = uses + 1 WHERE code = $1', [code]);
  }

  async revokeJoinCode(tournamentId: string, code: string): Promise<boolean> {
    return (
      ((await this.db.query('UPDATE join_codes SET revoked = true WHERE tournament_id = $1 AND code = $2', [tournamentId, code])).rowCount ?? 0) > 0
    );
  }

  // ---------------------------------------------------------------- cameras
  async camerasForTournament(tournamentId: string): Promise<CameraRow[]> {
    return (
      await this.db.query<CameraRow>(`SELECT * FROM cameras WHERE tournament_id = $1 ORDER BY sort_order, hole NULLS LAST, name`, [tournamentId])
    ).rows;
  }

  async cameraById(id: string): Promise<CameraRow | null> {
    return (await this.db.query<CameraRow>('SELECT * FROM cameras WHERE id = $1', [id])).rows[0] ?? null;
  }

  /** Any media path (camera or commentator) with its tournament keys, for the MediaMTX auth hook. */
  async mediaPath(path: string): Promise<{
    kind: 'camera' | 'commentator' | 'programme';
    publish_key: string;
    read_key: string;
    tournament_id: string;
    org_id: string;
    archived: boolean;
  } | null> {
    return (
      (
        await this.db.query(
          `SELECT 'camera' AS kind, c.publish_key, t.read_key, t.id AS tournament_id, t.org_id, t.archived
             FROM cameras c JOIN tournaments t ON t.id = c.tournament_id WHERE c.stream_path = $1
           UNION ALL
           SELECT 'commentator' AS kind, m.publish_key, t.read_key, t.id, t.org_id, t.archived
             FROM commentators m JOIN tournaments t ON t.id = m.tournament_id WHERE m.stream_path = $1
           UNION ALL
           SELECT 'programme' AS kind, t.output_key, t.read_key, t.id, t.org_id, t.archived
             FROM tournaments t WHERE $1 LIKE 'prog-%' AND 'prog-' || replace(t.id::text, '-', '') = $1 AND t.output_key IS NOT NULL`,
          [path],
        )
      ).rows[0] ?? null
    );
  }

  /**
   * Registers a phone as a camera. The same device re-registering keeps its camera,
   * path and key, so a crash or reinstall does not create a duplicate feed.
   */
  async registerCamera(input: {
    tournamentId: string;
    owner: string;
    /** null = keep this phone's earlier name, or the next "Cam N" (one-tap setup, P1-10). */
    name: string | null;
    hole: number | null;
    position: string | null;
    deviceId: string;
    platform: 'android' | 'ios' | 'other';
    deviceModel: string | null;
    /** Camera slots this tournament has (billing); null = no limit. */
    limit?: number | null;
  }): Promise<{ camera: CameraRow; created: boolean }> {
    return this.tx(async (c) => {
      // Serialise registrations per tournament so two phones cannot both take the last slot.
      await c.query('SELECT id FROM tournaments WHERE id = $1 FOR UPDATE', [input.tournamentId]);
      const existing = await c.query<CameraRow>('SELECT * FROM cameras WHERE tournament_id = $1 AND device_id = $2 FOR UPDATE', [
        input.tournamentId,
        input.deviceId,
      ]);
      if (existing.rows[0]) {
        const camera = (
          await c.query<CameraRow>(
            `UPDATE cameras SET name = $2, hole = $3, position = $4, device_platform = $5, device_model = $6, owner = $7, updated_at = now()
             WHERE id = $1 RETURNING *`,
            [existing.rows[0].id, input.name ?? existing.rows[0].name, input.hole, input.position, input.platform, input.deviceModel, input.owner],
          )
        ).rows[0];
        return { camera, created: false };
      }
      if (input.limit != null) {
        const n = Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM cameras WHERE tournament_id = $1', [input.tournamentId])).rows[0].n);
        if (n >= input.limit) throw new CameraLimitError(input.limit);
      }
      const order = await c.query<{ n: number }>('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM cameras WHERE tournament_id = $1', [
        input.tournamentId,
      ]);
      let name = input.name;
      if (!name) {
        // Next free "Cam N": one more than the highest number used so far in this event.
        const used = (await c.query<{ name: string }>('SELECT name FROM cameras WHERE tournament_id = $1', [input.tournamentId])).rows;
        const top = Math.max(0, ...used.map((r) => Number(/^Cam (\d+)$/.exec(r.name)?.[1] ?? 0)));
        name = `Cam ${Math.max(top, used.length) + 1}`;
      }
      const camera = (
        await c.query<CameraRow>(
          `INSERT INTO cameras (tournament_id, name, hole, position, stream_path, publish_key, device_id, device_platform, device_model, owner, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
          [
            input.tournamentId,
            name,
            input.hole,
            input.position,
            `cam-${randomSecret(5)}`,
            randomSecret(16),
            input.deviceId,
            input.platform,
            input.deviceModel,
            input.owner,
            order.rows[0].n,
          ],
        )
      ).rows[0];
      return { camera, created: true };
    });
  }

  async updateCamera(
    id: string,
    patch: { name?: string; hole?: number | null; position?: string | null; sortOrder?: number },
  ): Promise<CameraRow | null> {
    return (
      (
        await this.db.query<CameraRow>(
          `UPDATE cameras SET
             name = COALESCE($2, name),
             hole = CASE WHEN $3::boolean THEN $4::integer ELSE hole END,
             position = CASE WHEN $5::boolean THEN $6 ELSE position END,
             sort_order = COALESCE($7, sort_order),
             updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, patch.name ?? null, patch.hole !== undefined, patch.hole ?? null, patch.position !== undefined, patch.position ?? null, patch.sortOrder ?? null],
        )
      ).rows[0] ?? null
    );
  }

  async rotatePublishKey(id: string): Promise<CameraRow | null> {
    return (await this.db.query<CameraRow>('UPDATE cameras SET publish_key = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, randomSecret(16)]))
      .rows[0] ?? null;
  }

  async deleteCamera(id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM cameras WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  async saveTelemetry(id: string, telemetry: unknown): Promise<void> {
    await this.db.query('UPDATE cameras SET last_telemetry = $2, last_seen_at = now() WHERE id = $1', [id, JSON.stringify(telemetry)]);
  }

  // ---------------------------------------------------------------- commentators
  async commentatorsForTournament(tournamentId: string): Promise<CommentatorRow[]> {
    return (await this.db.query<CommentatorRow>('SELECT * FROM commentators WHERE tournament_id = $1 ORDER BY sort_order, created_at', [tournamentId]))
      .rows;
  }

  async commentatorById(id: string): Promise<CommentatorRow | null> {
    return (await this.db.query<CommentatorRow>('SELECT * FROM commentators WHERE id = $1', [id])).rows[0] ?? null;
  }

  async registerCommentator(input: { tournamentId: string; owner: string; name: string; deviceId: string }) {
    return this.tx(async (c) => {
      const existing = await c.query<CommentatorRow>(
        'SELECT * FROM commentators WHERE tournament_id = $1 AND device_id = $2 FOR UPDATE',
        [input.tournamentId, input.deviceId],
      );
      if (existing.rows[0]) {
        return (
          await c.query<CommentatorRow>('UPDATE commentators SET name = $2, owner = $3 WHERE id = $1 RETURNING *', [
            existing.rows[0].id,
            input.name,
            input.owner,
          ])
        ).rows[0];
      }
      const order = await c.query<{ n: number }>('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM commentators WHERE tournament_id = $1', [
        input.tournamentId,
      ]);
      return (
        await c.query<CommentatorRow>(
          `INSERT INTO commentators (tournament_id, name, stream_path, publish_key, device_id, owner, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [input.tournamentId, input.name, `com-${randomSecret(5)}`, randomSecret(16), input.deviceId, input.owner, order.rows[0].n],
        )
      ).rows[0];
    });
  }

  async deleteCommentator(id: string): Promise<boolean> {
    return ((await this.db.query('DELETE FROM commentators WHERE id = $1', [id])).rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------- audit
  async logSwitch(e: { tournamentId: string; actor: string | null; action: string; cameraId: string | null; ok: boolean; error?: string | null }) {
    await this.db.query(
      `INSERT INTO switch_log (tournament_id, actor, action, camera_id, ok, error) VALUES ($1, $2, $3, $4, $5, $6)`,
      [e.tournamentId, e.actor, e.action, e.cameraId, e.ok, e.error ?? null],
    );
  }

  async recentSwitches(tournamentId: string, limit = 50) {
    return (
      await this.db.query(`SELECT * FROM switch_log WHERE tournament_id = $1 ORDER BY id DESC LIMIT $2`, [tournamentId, limit])
    ).rows;
  }
}
