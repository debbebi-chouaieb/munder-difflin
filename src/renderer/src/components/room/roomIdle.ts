// Idle shutdown of room lead terminals (ADR 0005, Rooms-d): a lead whose terminal
// is not on screen and has printed nothing for `roomIdleMinutes` stops. Its
// session stays resumable from the room. Pure, so the rule is tested without React.

import { leadAgentIdFor, isLeadAgentId } from '@shared/roomLead';
import type { Project } from '@shared/project';

export interface LivePty {
  id: string;
  lastOutputAt: number;
}

export interface IdleLead {
  projectId: string;
  ptyId: string;
}

/**
 * The leads to stop now. `idleMinutes` 0 turns this off. A lead whose project is
 * gone is left alone: only its room can stop it, and it does not count toward the cap.
 */
export function idleLeadsToStop(
  ptys: readonly LivePty[],
  projects: ReadonlyArray<Pick<Project, 'id' | 'leadAgentId'>>,
  isOnScreen: (ptyId: string) => boolean,
  now: number,
  idleMinutes: number
): IdleLead[] {
  if (idleMinutes <= 0) return [];
  const idleMs = idleMinutes * 60_000;
  const stops: IdleLead[] = [];
  for (const pty of ptys) {
    if (!isLeadAgentId(pty.id) || isOnScreen(pty.id) || now - pty.lastOutputAt < idleMs) continue;
    const project = projects.find((p) => leadAgentIdFor(p) === pty.id);
    if (project) stops.push({ projectId: project.id, ptyId: pty.id });
  }
  return stops;
}
