// Which agent definitions a live session is running as subagents right now (ADR 0014).
// Pure: the renderer feeds hook events in and asks which sidebar rows to light.

import { isAgentName, type AgentDefinition } from './agentDefinition';
import { leadAgentIdFor } from './roomLead';

/** Hive agent id → Claude's subagent id → the subagent's type (its definition `name`). */
export type RunningSubagents = Readonly<Record<string, Readonly<Record<string, string>>>>;

export interface SubagentEvent {
  agentId?: string;
  event: string;
  subagentId?: string;
  subagentType?: string;
}

const SUBAGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSubagentId(value: unknown): value is string {
  return typeof value === 'string' && SUBAGENT_ID.test(value);
}

export function isSubagentType(value: unknown): value is string {
  return typeof value === 'string' && isAgentName(value);
}

/**
 * The next state after one hook event. SubagentStart adds a run, SubagentStop
 * removes it, and SessionStart (a new or respawned session) drops every run that
 * agent had. A lead's Stop does not: background subagents outlive the turn.
 */
export function withSubagentEvent(running: RunningSubagents, e: SubagentEvent): RunningSubagents {
  const agentId = e.agentId;
  if (!agentId) return running;
  if (e.event === 'SessionStart') return withoutAgent(running, agentId);
  if (!isSubagentId(e.subagentId)) return running;
  const runs = running[agentId] ?? {};
  if (e.event === 'SubagentStart' && isSubagentType(e.subagentType)) {
    if (runs[e.subagentId] === e.subagentType) return running;
    return { ...running, [agentId]: { ...runs, [e.subagentId]: e.subagentType } };
  }
  if (e.event === 'SubagentStop' && e.subagentId in runs) {
    const { [e.subagentId]: _stopped, ...rest } = runs;
    return Object.keys(rest).length === 0 ? withoutAgent(running, agentId) : { ...running, [agentId]: rest };
  }
  return running;
}

export function withoutAgent(running: RunningSubagents, agentId: string): RunningSubagents {
  if (!(agentId in running)) return running;
  const { [agentId]: _gone, ...rest } = running;
  return rest;
}

export interface ActiveRows {
  /** `file` keys of lit Tech leads rows. */
  globals: ReadonlySet<string>;
  /** Project id → `file` keys of lit Desks rows. */
  desks: Readonly<Record<string, ReadonlySet<string>>>;
}

interface ProjectAgents {
  id: string;
  leadAgentId: string | null;
  agents: AgentDefinition[];
}

/**
 * Claude's shadowing rule: a run by project P's lead whose type P defines lights
 * P's desk; any other run whose type is a global agent lights that global row.
 * Built-in or unknown types light nothing. Only agents in `live` count, so a run
 * whose SubagentStop never came stops showing once its agent leaves the floor.
 */
export function activeAgentRows(
  running: RunningSubagents,
  live: ReadonlySet<string>,
  projects: readonly ProjectAgents[],
  globals: readonly AgentDefinition[]
): ActiveRows {
  const projectOfLead = new Map(projects.map((p) => [leadAgentIdFor(p), p]));
  const globalFiles = new Set<string>();
  const desks: Record<string, Set<string>> = {};
  for (const [agentId, runs] of Object.entries(running)) {
    if (!live.has(agentId)) continue;
    const project = projectOfLead.get(agentId);
    for (const type of Object.values(runs)) {
      const desk = project?.agents.find((a) => a.name === type);
      if (project && desk) {
        (desks[project.id] ??= new Set()).add(desk.file);
        continue;
      }
      const global = globals.find((a) => a.name === type);
      if (global) globalFiles.add(global.file);
    }
  }
  return { globals: globalFiles, desks };
}
