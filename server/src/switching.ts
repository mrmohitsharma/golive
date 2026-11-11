/**
 * V9 camera switching: an automatic switch between live cameras (round-robin, or back to a main
 * camera between each of the others) every N seconds, and the transition (Fade or Slide) used
 * for every switch, by hand or automatic. Kept per event in tournaments.switching.
 */

export type TransitionStyle = 'fade' | 'slide';

export interface Switching {
  auto: { on: boolean; mode: 'round' | 'main'; mainCameraId: string | null; everySec: number };
  transition: { style: TransitionStyle; ms: number };
}

export const MIN_EVERY_SEC = 10;
export const MAX_EVERY_SEC = 30 * 60;

export function switchingOf(raw: unknown): Switching {
  const s = (raw ?? {}) as Partial<Switching>;
  const a = (s.auto ?? {}) as Partial<Switching['auto']>;
  const t = (s.transition ?? {}) as Partial<Switching['transition']>;
  const every = typeof a.everySec === 'number' && Number.isFinite(a.everySec) ? Math.round(a.everySec) : 60;
  const ms = typeof t.ms === 'number' && Number.isFinite(t.ms) ? Math.round(t.ms) : 700;
  return {
    auto: {
      on: Boolean(a.on),
      mode: a.mode === 'main' ? 'main' : 'round',
      mainCameraId: typeof a.mainCameraId === 'string' && /^[0-9a-f-]{36}$/.test(a.mainCameraId) ? a.mainCameraId : null,
      everySec: Math.min(MAX_EVERY_SEC, Math.max(MIN_EVERY_SEC, every)),
    },
    transition: { style: t.style === 'slide' ? 'slide' : 'fade', ms: Math.min(2000, Math.max(200, ms)) },
  };
}

export function patchSwitching(cur: Switching, p: Record<string, unknown>): Switching {
  const a = p.auto && typeof p.auto === 'object' ? (p.auto as Record<string, unknown>) : {};
  const t = p.transition && typeof p.transition === 'object' ? (p.transition as Record<string, unknown>) : {};
  return switchingOf({ auto: { ...cur.auto, ...a }, transition: { ...cur.transition, ...t } });
}

/** The OBS transition name for a style (the laptop app and Cloud OBS add "Slide"). */
export const OBS_TRANSITION: Record<TransitionStyle, string> = { fade: 'Fade', slide: 'Slide' };

/**
 * The next camera for an automatic switch. `usable` = cameras that can go on air now, in the
 * director's order. Round-robin: the one after the camera on air. Main: the main camera after
 * any other; after the main camera, the next of the others in turn (`lastOther`).
 */
export function nextCamera(usable: { id: string }[], current: string | null, s: Switching['auto'], lastOther: string | null): string | null {
  if (!usable.length) return null;
  const ids = usable.map((c) => c.id);
  const after = (from: string | null, list: string[]) => {
    if (!list.length) return null;
    const i = from ? list.indexOf(from) : -1;
    return list[(i + 1) % list.length];
  };
  if (s.mode === 'main' && s.mainCameraId && ids.includes(s.mainCameraId)) {
    if (current !== s.mainCameraId) return s.mainCameraId;
    const others = ids.filter((id) => id !== s.mainCameraId);
    if (!others.length) return null;
    // Continue after the last "other" camera shown; if it left, start from where it stood.
    return after(lastOther && others.includes(lastOther) ? lastOther : null, others);
  }
  const next = after(current && ids.includes(current) ? current : null, ids);
  return next === current ? null : next;
}
