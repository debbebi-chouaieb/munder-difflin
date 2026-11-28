// What the renderer may ask of `pty:spawn`: the fields of the preload's
// SpawnPtyOptions and nothing else. `env`, `shellScript`, `untrusted` and
// `noAutoInstall` are main's own; a renderer that sends them (an injected
// script) would otherwise pick environment variables such as NODE_OPTIONS or
// run a raw shell script (pty:spawn audit, 2026-11-28).

import type { AgentProvider } from '../shared/agentProvider';

export interface RendererHiveMeta {
  id: string;
  name: string;
  cwd: string;
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  isGod?: boolean;
  isAssistant?: boolean;
}

export interface RendererSpawnRequest {
  id: string;
  cwd: string;
  command: string;
  provider?: AgentProvider;
  args?: string[];
  cols?: number;
  rows?: number;
  hive?: RendererHiveMeta;
  isolate?: boolean;
  resume?: boolean;
  requireResume?: boolean;
  resumeSessionId?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const isGridSize = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000;

function hiveMetaFrom(raw: unknown): RendererHiveMeta | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.cwd !== 'string') return null;
  if (raw.capabilities !== undefined && !isStringArray(raw.capabilities)) return null;
  return {
    id: raw.id,
    name: raw.name,
    cwd: raw.cwd,
    ...(typeof raw.provider === 'string' ? { provider: raw.provider as AgentProvider } : {}),
    ...(typeof raw.role === 'string' ? { role: raw.role } : {}),
    ...(raw.capabilities !== undefined ? { capabilities: [...raw.capabilities] } : {}),
    ...(raw.isGod === true ? { isGod: true } : {}),
    ...(raw.isAssistant === true ? { isAssistant: true } : {})
  };
}

/**
 * The spawn the renderer asked for, rebuilt from known fields only; null when a
 * required field is missing or a known field has the wrong type. Unknown fields
 * are dropped, so main-only options can never come from the renderer.
 */
export function spawnRequestFromRenderer(raw: unknown): RendererSpawnRequest | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.cwd !== 'string' || typeof raw.command !== 'string') return null;
  if (raw.args !== undefined && !isStringArray(raw.args)) return null;
  if (raw.cols !== undefined && !isGridSize(raw.cols)) return null;
  if (raw.rows !== undefined && !isGridSize(raw.rows)) return null;
  if (raw.provider !== undefined && typeof raw.provider !== 'string') return null;
  if (raw.resumeSessionId !== undefined && typeof raw.resumeSessionId !== 'string') return null;
  const flag = (v: unknown): boolean | undefined | null => (v === undefined ? undefined : typeof v === 'boolean' ? v : null);
  const isolate = flag(raw.isolate);
  const resume = flag(raw.resume);
  const requireResume = flag(raw.requireResume);
  if (isolate === null || resume === null || requireResume === null) return null;
  const hive = raw.hive === undefined ? undefined : hiveMetaFrom(raw.hive);
  if (hive === null) return null;
  return {
    id: raw.id,
    cwd: raw.cwd,
    command: raw.command,
    ...(raw.provider !== undefined ? { provider: raw.provider as AgentProvider } : {}),
    ...(raw.args !== undefined ? { args: [...raw.args] } : {}),
    ...(raw.cols !== undefined ? { cols: raw.cols } : {}),
    ...(raw.rows !== undefined ? { rows: raw.rows } : {}),
    ...(hive ? { hive } : {}),
    ...(isolate !== undefined ? { isolate } : {}),
    ...(resume !== undefined ? { resume } : {}),
    ...(requireResume !== undefined ? { requireResume } : {}),
    ...(raw.resumeSessionId !== undefined ? { resumeSessionId: raw.resumeSessionId } : {})
  };
}
