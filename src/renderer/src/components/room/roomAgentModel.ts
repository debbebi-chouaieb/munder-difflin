// The room's agent list and its lead picker (ADR 0015), kept free of React so the
// choices can be tested. The panel only renders what these return.

import type { AgentDefinition } from '@shared/agentDefinition';
import { choosableGlobalAgents, resolveMainAgent, type MainAgent, type MainAgentRef } from '@shared/mainAgent';
import type { Project } from '@shared/project';

/** The picker's value for "no room choice"; any other value is `<scope>:<file>`. */
export const DEFAULT_LEAD_VALUE = '';

export interface LeadOption {
  value: string;
  /** An agent name, or null for the default option (its label is translated). */
  name: string | null;
  model: string | null;
  group: 'default' | 'project' | 'global' | 'missing';
}

export function leadValueOf(ref: MainAgentRef | null): string {
  return ref ? `${ref.scope}:${ref.file}` : DEFAULT_LEAD_VALUE;
}

/** The ref a picker value names, or null for the default option or a value no option has. */
export function leadRefOf(value: string, options: LeadOption[]): MainAgentRef | null {
  const option = options.find((o) => o.value === value);
  if (!option || (option.group !== 'project' && option.group !== 'global')) return null;
  const colon = value.indexOf(':');
  return { scope: option.group, file: value.slice(colon + 1) };
}

type LeadProject = Pick<Project, 'agents' | 'mainAgent' | 'settingsAgent' | 'agentsFullyRead' | 'trusted'>;

/**
 * The default first, then the project's agents, then the global ones no project
 * agent shadows. A room choice that is no longer listed keeps an option of its own,
 * so the picker shows what is stored rather than silently showing the default.
 */
export function leadOptions(project: LeadProject, globalAgents: AgentDefinition[]): LeadOption[] {
  const option = (group: 'project' | 'global') => (a: AgentDefinition): LeadOption =>
    ({ value: `${group}:${a.file}`, name: a.name, model: a.model, group });
  const options: LeadOption[] = [
    { value: DEFAULT_LEAD_VALUE, name: null, model: null, group: 'default' },
    ...project.agents.map(option('project')),
    ...choosableGlobalAgents(project, globalAgents).map(option('global'))
  ];
  const stored = leadValueOf(project.mainAgent);
  if (project.mainAgent && !options.some((o) => o.value === stored)) {
    options.push({ value: stored, name: project.mainAgent.file, model: null, group: 'missing' });
  }
  return options;
}

export interface LeadStatus {
  agent: MainAgent;
  /** i18n key of the default option's label, with `name` when the repo sets one. */
  defaultLabelKey: 'room.agents.leadDefaultHive' | 'room.agents.leadDefaultSettings';
  /** i18n keys of the lines shown under the picker, in order. */
  notes: { key: string; warn: boolean; name?: string }[];
}

export function leadStatus(project: LeadProject, globalAgents: AgentDefinition[], leadRunning: boolean): LeadStatus {
  const agent = resolveMainAgent(project, globalAgents);
  const notes: LeadStatus['notes'] = [];
  if (agent.source === 'room-missing') notes.push({ key: 'room.agents.leadMissing', warn: true, name: agent.file });
  if (agent.source === 'room-ambiguous') notes.push({ key: 'room.agents.leadAmbiguous', warn: true, name: agent.name });
  // Main applies a repo agent only to a trusted lead (leadAgentOf); say so rather than look applied.
  if (agent.source === 'room' && agent.scope === 'project' && !project.trusted) notes.push({ key: 'room.agents.leadNeedsTrust', warn: true });
  if (agent.source === 'room' && !agent.delegates) notes.push({ key: 'room.agents.leadNoDelegate', warn: true });
  if (leadRunning) notes.push({ key: 'room.agents.leadNextStart', warn: false });
  return {
    agent,
    defaultLabelKey: project.settingsAgent ? 'room.agents.leadDefaultSettings' : 'room.agents.leadDefaultHive',
    notes
  };
}

/** Whether this project agent is the one the room's lead runs as, by room choice or by the repo setting. */
export function isLeadRow(agent: MainAgent, def: AgentDefinition): boolean {
  if (agent.source === 'room') return agent.scope === 'project' && agent.file === def.file;
  return agent.source === 'project-settings' && agent.name === def.name;
}
