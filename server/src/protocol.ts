/**
 * Real-time protocol shared by the server, the OBS engine agent and the mobile apps.
 * Every WebSocket frame is a JSON object with a `type` field. Documented in docs/PROTOCOL.md.
 */

export type CameraStreamState = 'idle' | 'previewing' | 'connecting' | 'live' | 'reconnecting' | 'paused' | 'error';

export interface CameraTelemetry {
  state: CameraStreamState;
  bitrateKbps?: number | null;
  battery?: number | null;
  charging?: boolean | null;
  durationSec?: number | null;
  appState?: 'foreground' | 'background' | null;
  resolution?: string | null;
  fps?: number | null;
  thermal?: string | null;
  error?: string | null;
}

export interface CameraHealth {
  online: boolean;
  onlineSince: string | null;
  inboundKbps: number;
  readers: number;
  tracks: string[];
}

export interface StreamOutputStatus {
  active: boolean;
  reconnecting: boolean;
  timecode?: string | null;
  kbps?: number | null;
  congestion?: number | null;
  skippedFrames?: number | null;
  totalFrames?: number | null;
}

export interface EngineState {
  connected: boolean;
  obsConnected: boolean;
  obsVersion?: string | null;
  programmeCameraId: string | null;
  previewCameraId: string | null;
  programmeScene: string | null;
  previewScene: string | null;
  fallbackActive: boolean;
  replayActive: boolean;
  studioMode: boolean;
  streaming: StreamOutputStatus;
  /** Things the operator should fix, e.g. "OBS has no Browser Source: graphics disabled". */
  warnings: string[];
  lastError?: string | null;
  updatedAt: string | null;
}

export type DirectorAction = 'preview' | 'take' | 'cut' | 'fallback' | 'stream.start' | 'stream.stop' | 'replay';
export const DIRECTOR_ACTIONS: DirectorAction[] = ['preview', 'take', 'cut', 'fallback', 'stream.start', 'stream.stop', 'replay'];

export interface EngineCamera {
  id: string;
  name: string;
  hole: number | null;
  position: string | null;
  streamPath: string;
  sceneName: string;
  inputName: string;
  srtUrl: string;
}

export interface EngineCommentator {
  id: string;
  name: string;
  streamPath: string;
  inputName: string;
  srtUrl: string;
}

// ---------------------------------------------------------------- graphics
export interface GraphicsState {
  lowerThird: { visible: boolean; playerId: string | null; title: string; subtitle: string };
  holeCard: { auto: boolean; visible: boolean; hole: number | null; durationSec: number };
  leaderboard: { visible: boolean; size: number; category: string | null };
  scoreBug: { visible: boolean };
  /** A viewer's question from the chat, shown on air (replaces the lower third while up). */
  question: { visible: boolean; author: string; source: string; text: string };
  replay: boolean;
}

export function defaultGraphics(): GraphicsState {
  return {
    lowerThird: { visible: false, playerId: null, title: '', subtitle: '' },
    holeCard: { auto: true, visible: false, hole: null, durationSec: 8 },
    leaderboard: { visible: false, size: 8, category: null },
    scoreBug: { visible: true },
    question: { visible: false, author: '', source: '', text: '' },
    replay: false,
  };
}

// ---------------------------------------------------------------- audio
export interface AudioState {
  /** Master level for all camera (course) audio, dB (-60..+6). */
  courseDb: number;
  courseMuted: boolean;
  /** Per-camera trims and mutes. */
  cameras: Record<string, { db: number; muted: boolean }>;
  commentaryDb: number;
  commentaryMuted: boolean;
  /** Lower course audio automatically while the primary commentator speaks. */
  ducking: boolean;
  /** Delay commentary to line up with camera video (ms, 0..2000). */
  commentaryDelayMs: number;
}

export function defaultAudio(): AudioState {
  return { courseDb: 0, courseMuted: false, cameras: {}, commentaryDb: 0, commentaryMuted: false, ducking: true, commentaryDelayMs: 0 };
}

// ---------------------------------------------------------------- production
export type CloudEngineStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ProductionState {
  mode: 'laptop' | 'cloud';
  cloudAvailable: boolean;
  cloud: {
    status: CloudEngineStatus;
    startedAt: string | null;
    error: string | null;
    costPerHour: number;
    autoStopAfterIdleMin: number;
  };
}

export interface YoutubeState {
  connected: boolean;
  channelTitle: string | null;
  broadcastId: string | null;
  watchUrl: string | null;
  privacy: string | null;
  lifeCycleStatus: string | null;
  streamStatus: string | null;
  health: string | null;
  issues: string[];
  checkedAt: string | null;
  error: string | null;
}

export function emptyEngineState(): EngineState {
  return {
    connected: false,
    obsConnected: false,
    obsVersion: null,
    programmeCameraId: null,
    previewCameraId: null,
    programmeScene: null,
    previewScene: null,
    fallbackActive: false,
    replayActive: false,
    studioMode: false,
    streaming: { active: false, reconnecting: false },
    warnings: [],
    lastError: null,
    updatedAt: null,
  };
}

/** OBS names. Stable across renames (built from the media path, not the display name). */
export function sceneNameFor(streamPath: string): string {
  return `CG ${streamPath}`;
}
export function feedInputFor(streamPath: string): string {
  return `CG ${streamPath} Feed`;
}
export function commentaryInputFor(streamPath: string): string {
  return `CG Commentary ${streamPath}`;
}

export const FALLBACK_SCENE = 'CG Fallback';
export const REPLAY_SCENE = 'CG Replay';
export const REPLAY_INPUT = 'CG Replay Clip';
export const GRAPHICS_INPUT = 'CG Graphics';
