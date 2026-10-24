import type { Config } from './config.js';
import type { Repo } from './repo.js';
import { verifyPrincipal } from './auth.js';
import { can, roleInTournament } from './authz.js';
import { constantTimeEqual } from './crypto.js';

/**
 * SRT URL a phone publishes to. Stream ID format is MediaMTX's "publish:<path>:<user>:<pass>".
 * Secrets are hex, so the URL needs no escaping. `latency` is in milliseconds for both mobile SDKs.
 */
export function publishUrl(config: Config, path: string, publishKey: string): string {
  const q = [`streamid=publish:${path}:cam:${publishKey}`, `latency=${config.SRT_LATENCY_MS}`];
  if (config.SRT_PASSPHRASE) q.push(`passphrase=${config.SRT_PASSPHRASE}`, 'pbkeylen=16');
  return `srt://${config.PUBLIC_SRT_HOST}:${config.PUBLIC_SRT_PORT}?${q.join('&')}`;
}

/**
 * SRT URL OBS reads from (Media Source, FFmpeg-based). FFmpeg's `latency` is in MICROseconds.
 * Cloud OBS reaches MediaMTX over the internal network when ENGINE_SRT_HOST is set.
 */
export function engineReadUrl(config: Config, path: string, readKey: string, mode: 'laptop' | 'cloud'): string {
  const host = mode === 'cloud' && config.ENGINE_SRT_HOST ? config.ENGINE_SRT_HOST : config.PUBLIC_SRT_HOST;
  const port = mode === 'cloud' && config.ENGINE_SRT_HOST ? (config.ENGINE_SRT_PORT ?? config.PUBLIC_SRT_PORT) : config.PUBLIC_SRT_PORT;
  const q = [`streamid=read:${path}:engine:${readKey}`, `latency=${config.SRT_LATENCY_MS * 1000}`, 'mode=caller'];
  if (config.SRT_PASSPHRASE) q.push(`passphrase=${config.SRT_PASSPHRASE}`, 'pbkeylen=16');
  return `srt://${host}:${port}?${q.join('&')}`;
}

/** MediaMTX path the engine publishes its programme (final mix) to, for restreaming. */
export function programmePath(tournamentId: string): string {
  return `prog-${tournamentId.replace(/-/g, '')}`;
}

/**
 * Where OBS sends its programme when the server restreams: SRT to MediaMTX (OBS 30 sends
 * MPEG-TS over SRT from a custom server URL). Laptop OBS uses the public host; cloud OBS
 * the internal one. FFmpeg/OBS `latency` is in microseconds.
 */
export function engineOutputUrl(config: Config, tournamentId: string, outputKey: string, mode: 'laptop' | 'cloud'): string {
  const internal = mode === 'cloud' && config.ENGINE_SRT_HOST;
  const host = internal ? config.ENGINE_SRT_HOST : config.PUBLIC_SRT_HOST;
  const port = internal ? (config.ENGINE_SRT_PORT ?? config.PUBLIC_SRT_PORT) : config.PUBLIC_SRT_PORT;
  const q = [`streamid=publish:${programmePath(tournamentId)}:engine:${outputKey}`, `latency=${config.SRT_LATENCY_MS * 1000}`, 'pkt_size=1316'];
  if (config.SRT_PASSPHRASE) q.push(`passphrase=${config.SRT_PASSPHRASE}`, 'pbkeylen=16');
  return `srt://${host}:${port}?${q.join('&')}`;
}

/** Internal RTSP URL the server's relays read the programme from. */
export function internalRtspUrl(config: Config, path: string): string {
  const u = encodeURIComponent(config.INTERNAL_MEDIA_USER);
  const pw = encodeURIComponent(config.INTERNAL_MEDIA_PASS);
  return `rtsp://${u}:${pw}@${config.MEDIAMTX_RTSP_URL.replace('rtsp://', '').replace(/\/$/, '')}/${path}`;
}

export function whepUrl(config: Config, path: string): string {
  return `${config.PUBLIC_WEBRTC_BASE.replace(/\/$/, '')}/${path}/whep`;
}

export function whipUrl(config: Config, path: string): string {
  return `${config.PUBLIC_WEBRTC_BASE.replace(/\/$/, '')}/${path}/whip`;
}

export interface MediaAuthRequest {
  ip?: string;
  user?: string;
  password?: string;
  token?: string;
  action?: string;
  path?: string;
  protocol?: string;
  query?: string;
}

export interface MediaAuthDecision {
  allow: boolean;
  reason: string;
}

/**
 * Decides every MediaMTX action (publish, read, playback, api...). Called by MediaMTX's
 * authHTTPAddress hook. Deny by default.
 */
export async function decideMediaAuth(config: Config, repo: Repo, req: MediaAuthRequest): Promise<MediaAuthDecision> {
  const user = req.user ?? '';
  const pass = req.password ?? '';
  const action = req.action ?? '';
  const path = req.path ?? '';
  const protocol = req.protocol ?? '';

  const isInternal = user === config.INTERNAL_MEDIA_USER && pass.length > 0 && constantTimeEqual(pass, config.INTERNAL_MEDIA_PASS);

  if (action === 'api' || action === 'metrics' || action === 'pprof' || action === 'playback') {
    return isInternal ? { allow: true, reason: 'internal' } : { allow: false, reason: 'internal only' };
  }

  if (action === 'publish') {
    const m = await repo.mediaPath(path);
    if (!m) return { allow: false, reason: 'unknown path' };
    if (m.archived) return { allow: false, reason: 'tournament archived' };
    // Cameras: SRT from the native publisher. Commentators: WebRTC (WHIP) from the app, or SRT.
    // Programme: the broadcast engine's final mix, SRT only.
    const allowed = m.kind === 'commentator' ? protocol === 'webrtc' || protocol === 'srt' : protocol === 'srt';
    if (!allowed) return { allow: false, reason: `publishing a ${m.kind} over ${protocol} is not allowed` };
    if (!pass || !constantTimeEqual(pass, m.publish_key)) return { allow: false, reason: 'bad publish key' };
    return { allow: true, reason: `${m.kind} publish` };
  }

  if (action === 'read') {
    if (isInternal) return { allow: true, reason: 'internal read' };
    const m = await repo.mediaPath(path);
    if (!m) return { allow: false, reason: 'unknown path' };
    if (pass && constantTimeEqual(pass, m.read_key)) return { allow: true, reason: 'engine read' };
    // App previews (WebRTC/WHEP): JWT in the Authorization: Bearer header.
    const jwt = req.token || (user === 'jwt' ? pass : '');
    if (jwt) {
      const p = verifyPrincipal(config, jwt);
      const t = p ? await repo.tournamentById(m.tournament_id) : null;
      if (p && t) {
        const role = await roleInTournament(repo, p, t);
        if (can(role, 'watch')) return { allow: true, reason: `preview by ${role}` };
      }
    }
    return { allow: false, reason: 'not authorised to read' };
  }

  return { allow: false, reason: `action ${action} not allowed` };
}
