import type { OrgRole, Principal } from './auth.js';
import { HttpError } from './errors.js';
import type { Repo, TournamentRow } from './repo.js';

/** Effective role of a principal in a tournament ('engine' for the OBS agent). */
export type TournamentRole = OrgRole | 'engine';

/**
 * What each role may do in a tournament. One table, used by REST routes, the WebSocket
 * hub and the MediaMTX auth hook, so Android, iOS, the agent and the server agree.
 */
export const CAPABILITIES = {
  /** Switch programme, graphics, replay, audio, YouTube start/stop. */
  direct: ['owner', 'director'],
  /** Tournament settings, cameras, players, holes, join codes, production mode. */
  manage: ['owner', 'director'],
  /** Enter scores. */
  score: ['owner', 'director', 'scorer'],
  /** Publish commentary audio. */
  commentate: ['owner', 'director', 'commentator'],
  /** Register a phone as a camera and publish video. */
  camera: ['owner', 'director', 'camera'],
  /** Watch live previews (WebRTC) and follow the control room. */
  watch: ['owner', 'director', 'commentator'],
  /** See the leaderboard and tournament state. */
  view: ['owner', 'director', 'scorer', 'commentator', 'camera'],
  /** The broadcast engine agent. */
  engine: ['engine'],
} as const satisfies Record<string, readonly TournamentRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export const ORG_CAPABILITIES = {
  /** Members, YouTube connection, billing-like settings. */
  admin: ['owner'],
  /** Create tournaments. */
  create: ['owner', 'director'],
  view: ['owner', 'director', 'scorer', 'commentator', 'camera'],
} as const satisfies Record<string, readonly OrgRole[]>;

export type OrgCapability = keyof typeof ORG_CAPABILITIES;

export async function roleInTournament(repo: Repo, p: Principal, t: TournamentRow): Promise<TournamentRole | null> {
  switch (p.kind) {
    case 'user':
      if (p.platformAdmin) return 'owner';
      return repo.memberRole(t.org_id, p.id);
    case 'guest':
      return p.tournamentId === t.id ? p.role : null;
    case 'engine':
      return p.tournamentId === t.id ? 'engine' : null;
  }
}

export function can(role: TournamentRole | null, cap: Capability): boolean {
  return role !== null && (CAPABILITIES[cap] as readonly string[]).includes(role);
}

export async function roleInOrg(repo: Repo, p: Principal, orgId: string): Promise<OrgRole | null> {
  if (p.kind !== 'user') return null;
  if (p.platformAdmin) return 'owner';
  return repo.memberRole(orgId, p.id);
}

export function canOrg(role: OrgRole | null, cap: OrgCapability): boolean {
  return role !== null && (ORG_CAPABILITIES[cap] as readonly string[]).includes(role);
}

const CAP_TEXT: Record<Capability, string> = {
  direct: 'direct the broadcast',
  manage: 'manage this tournament',
  score: 'enter scores',
  commentate: 'commentate',
  camera: 'stream a camera',
  watch: 'watch the live previews',
  view: 'view this tournament',
  engine: 'act as the broadcast engine',
};

/** Loads the tournament and checks the capability; throws a consistent 403/404. */
export async function requireTournament(
  repo: Repo,
  p: Principal,
  tournamentId: string,
  cap: Capability,
): Promise<{ t: TournamentRow; role: TournamentRole }> {
  const t = await repo.tournamentById(tournamentId);
  if (!t) throw new HttpError(404, 'tournament_not_found', 'Tournament not found.');
  const role = await roleInTournament(repo, p, t);
  if (!role) throw new HttpError(404, 'tournament_not_found', 'Tournament not found.');
  if (!can(role, cap)) throw new HttpError(403, 'forbidden', `Your role (${role}) cannot ${CAP_TEXT[cap]}.`);
  return { t, role };
}

export async function requireOrg(repo: Repo, p: Principal, orgId: string, cap: OrgCapability): Promise<OrgRole> {
  const role = await roleInOrg(repo, p, orgId);
  if (!role) throw new HttpError(404, 'org_not_found', 'Organisation not found.');
  if (!canOrg(role, cap)) throw new HttpError(403, 'forbidden', `Your role (${role}) cannot do this in this organisation.`);
  return role;
}
