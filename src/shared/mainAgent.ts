// Which agent a room's lead runs as (ADR 0015). Pure: main decides it at every lead
// spawn from the current snapshot, and the panel shows the same answer.

import { isAgentName, type AgentDefinition } from './agentDefinition';

export type AgentScope = 'project' | 'global';

/** The room's own choice, stored in projects.json: a definition's stable key (ADR 0009). */
export interface MainAgentRef {
  scope: AgentScope;
  file: string;
}

export type MainAgent =
  /** Chosen in the room: the spawn adds `--agent <name>`. */
  | { source: 'room'; scope: AgentScope; file: string; name: string; delegates: boolean }
  /** Chosen in the room, but the file is gone or a project agent shadows its name: no flag. */
  | { source: 'room-missing'; scope: AgentScope; file: string }
  /** Chosen in the room, but another file in its folder declares the same name: `--agent` could run either, so no flag. */
  | { source: 'room-ambiguous'; scope: AgentScope; file: string; name: string }
  /** The repo's own `agent` setting: Claude applies it, the spawn adds nothing. */
  | { source: 'project-settings'; name: string }
  | { source: 'hive' };

/** A settings file bigger than this is not read: we only look for one key. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export function isMainAgentRef(value: unknown): value is MainAgentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { scope, file } = value as Record<string, unknown>;
  return (scope === 'project' || scope === 'global') && typeof file === 'string' && isAgentName(file);
}

/** The `agent` key of a Claude settings file's text, or null when absent, invalid or not JSON. */
export function settingsAgentFrom(text: string | null): string | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const agent = (parsed as Record<string, unknown>).agent;
  return typeof agent === 'string' && isAgentName(agent) ? agent : null;
}

export interface MainAgentInputs {
  mainAgent: MainAgentRef | null;
  settingsAgent: string | null;
  agents: AgentDefinition[];
  /**
   * The scan understood every definition Claude could load from the project's agents
   * folder. When not, a repo agent we did not see could carry a global choice's name.
   */
  agentsFullyRead: boolean;
}

/** Claude may match agent names without regard to case: compare them that way. */
function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The room choice when its definition is still listed, else the repo setting, else
 * the hive default. Claude resolves `--agent` by name with project agents first, so a
 * global choice that a project agent of the same name shadows would run that other
 * one: it counts as missing instead.
 */
export function resolveMainAgent(project: MainAgentInputs, globalAgents: AgentDefinition[]): MainAgent {
  const choice = project.mainAgent;
  if (choice) {
    const list = choice.scope === 'project' ? project.agents : globalAgents;
    const def = list.find((a) => a.file === choice.file);
    const shadowed = choice.scope === 'global' && !!def && !choosableGlobalAgents(project, [def]).length;
    if (!def || shadowed) return { source: 'room-missing', scope: choice.scope, file: choice.file };
    if (list.some((a) => a !== def && sameName(a.name, def.name))) return { source: 'room-ambiguous', scope: choice.scope, file: def.file, name: def.name };
    return { source: 'room', scope: choice.scope, file: def.file, name: def.name, delegates: def.delegates };
  }
  if (project.settingsAgent) return { source: 'project-settings', name: project.settingsAgent };
  return { source: 'hive' };
}

/**
 * Global agents a room may choose: those no project agent shadows by name, and none
 * at all when the project's agents folder was not fully read.
 */
export function choosableGlobalAgents(project: Pick<MainAgentInputs, 'agents' | 'agentsFullyRead'>, globalAgents: AgentDefinition[]): AgentDefinition[] {
  if (!project.agentsFullyRead) return [];
  return globalAgents.filter((g) => !project.agents.some((a) => sameName(a.name, g.name)));
}

/** Flags that can define agents or settings; a lead gets only main's own (ADR 0015). Each takes one value. */
const AGENT_DEFINING_FLAGS = ['--agent', '--agents', '--settings', '--setting-sources', '--plugin-dir'];

/**
 * A lead's args without any flag that can define agents or settings, then
 * `--agent <name>` for a room choice. Replayed args (card restart, Restore team) come
 * from the renderer, so a stale or forged choice never survives, and neither does an
 * inline `--agents` definition or a `--settings` that names another agent. Main adds
 * its own `--settings` (hooks) after this.
 */
export function withLeadAgentArgs(args: readonly string[], agent: MainAgent): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (AGENT_DEFINING_FLAGS.includes(a)) { i++; continue; }
    if (AGENT_DEFINING_FLAGS.some((flag) => a.startsWith(`${flag}=`))) continue;
    out.push(a);
  }
  return agent.source === 'room' ? [...out, '--agent', agent.name] : out;
}
