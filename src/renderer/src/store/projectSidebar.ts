/**
 * Rules behind the left project sidebar (ADR 0001, Phase 2).
 *
 * Structural and free of zustand/React so they are unit-testable, the same
 * reasoning as `focusMode.ts`.
 */
import { isValidZetahubKey, projectIdForCwd, type Project } from '@shared/project';

export const PROJECT_SIDEBAR_DEFAULT_WIDTH = 260;
export const PROJECT_SIDEBAR_MIN_WIDTH = 200;
export const PROJECT_SIDEBAR_MAX_WIDTH = 400;

export function clampProjectSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return PROJECT_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(PROJECT_SIDEBAR_MAX_WIDTH, Math.max(PROJECT_SIDEBAR_MIN_WIDTH, Math.round(px)));
}

/** The subset of an agent the sidebar needs. */
export interface SidebarAgent {
  id: string;
  name: string;
  cwd: string;
  isGod?: boolean;
  isAssistant?: boolean;
  archived?: boolean;
}

export interface SidebarGroups<A extends SidebarAgent> {
  ceo: A | null;
  /** Running agents per project id. */
  byProject: Record<string, A[]>;
}

/**
 * Sorts the live agents into the CEO and the projects they work in. The prep
 * assistant and archived agents are not shown; agents outside every project
 * (for example in the hive home) are not listed under a project.
 */
export function groupAgents<A extends SidebarAgent>(agents: A[], projects: Pick<Project, 'id' | 'path'>[]): SidebarGroups<A> {
  const byProject: Record<string, A[]> = Object.create(null);
  let ceo: A | null = null;
  for (const agent of agents) {
    if (agent.archived || agent.isAssistant) continue;
    if (agent.isGod) {
      ceo ??= agent;
      continue;
    }
    const id = projectIdForCwd(agent.cwd, projects);
    if (!id) continue;
    (byProject[id] ??= []).push(agent);
  }
  return { ceo, byProject };
}

/**
 * Translation key for an error string from main (src/main/projects.ts), so the
 * Arabic and Chinese UI do not show English. Unknown errors return null and are
 * shown as they came.
 */
export function projectErrorKey(message: string): string | null {
  if (message === 'pick a local folder') return 'projectSidebar.errors.pickLocal';
  if (message === 'no hive yet') return 'projectSidebar.errors.noHive';
  if (message === 'invalid ZetaHub key') return 'projectSidebar.errors.invalidKey';
  if (message === 'unknown project') return 'projectSidebar.errors.unknownProject';
  if (message === 'projects.json cannot be read') return 'projectSidebar.errors.fileUnreadable';
  if (message === 'projects.json is not valid JSON') return 'projectSidebar.errors.fileInvalid';
  if (message === 'projects.json is too large') return 'projectSidebar.errors.fileTooLarge';
  if (message === 'workspace is not a local folder') return 'projectSidebar.errors.workspaceNotLocal';
  if (message.startsWith('cannot read workspace')) return 'projectSidebar.errors.workspaceUnreadable';
  return null;
}

/** What the key editor should do with a draft when the user commits it. */
export function keyDraftAction(draft: string, current: string | null): 'unchanged' | 'clear' | 'save' | 'invalid' {
  const key = draft.trim().toUpperCase();
  if (key === (current ?? '')) return 'unchanged';
  if (key === '') return 'clear';
  return isValidZetahubKey(key) ? 'save' : 'invalid';
}

/** Workspace folder name for the header, from a Windows or POSIX path. */
export function workspaceLabel(root: string | null): string {
  if (!root) return '';
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || root;
}
