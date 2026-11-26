import { isSubagentId, isSubagentType } from './subagentActivity';

/** Renderer-facing hook event shared across the Electron IPC boundary. */
export interface HookEvent {
  agentId?: string;
  event: string;
  tool?: string;
  notificationType?: string;
  source?: string;
  message?: string;
  blocked?: boolean;
  /** Claude's id for the subagent the event came from (ADR 0014). */
  subagentId?: string;
  /** That subagent's type: its definition's frontmatter `name` (ADR 0014). */
  subagentType?: string;
}

const OPTIONAL_STRING_FIELDS = ['tool', 'notificationType', 'source', 'message'] as const;

/** Validate an untrusted payload before it crosses the Electron IPC boundary. */
export function validateHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== 'string' || candidate.event.length === 0) return false;
  if (
    candidate.agentId !== undefined &&
    (typeof candidate.agentId !== 'string' || candidate.agentId.length === 0)
  ) return false;

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }

  if (candidate.subagentId !== undefined && !isSubagentId(candidate.subagentId)) return false;
  if (candidate.subagentType !== undefined && !isSubagentType(candidate.subagentType)) return false;

  return candidate.blocked === undefined || typeof candidate.blocked === 'boolean';
}
