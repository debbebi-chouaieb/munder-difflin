/**
 * Agent definition files opened in the person's editor or moved to the trash from
 * the room panel (ADR 0015). The renderer sends a scope, a project id and a file
 * key; main builds the path itself and only for a definition listed right now.
 */
import { ipcMain } from 'electron';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { agentNameOfFile, type AgentFileError, type AgentFileResult } from '../shared/agentDefinition';
import type { AgentScope } from '../shared/mainAgent';
import type { ProjectsSnapshot } from '../shared/project';

export interface AgentFileDeps {
  snapshot(): Promise<ProjectsSnapshot>;
  globalAgentsDir: string;
  /** `shell.openPath`: resolves to an error text, empty on success. */
  openPath(path: string): Promise<string>;
  /** `shell.trashItem`. */
  trashItem(path: string): Promise<void>;
  rescan(): Promise<unknown>;
  log(line: string): void;
}

interface AgentFileRequest {
  scope: AgentScope;
  projectId: string | null;
  file: string;
}

function parseRequest(scope: unknown, projectId: unknown, file: unknown): AgentFileRequest | null {
  if (scope !== 'project' && scope !== 'global') return null;
  if (typeof file !== 'string' || agentNameOfFile(`${file}.md`) !== file) return null;
  if (scope === 'project' ? typeof projectId !== 'string' : projectId !== null) return null;
  return { scope, projectId: scope === 'project' ? (projectId as string) : null, file };
}

/**
 * The definition's file on disk: in real (not linked) folders, a plain `.md` file
 * whose name gives the key. The extension may be any case (`Go.MD`). `realDirs`:
 * the folders that must not be links, the agents folder last.
 */
async function definitionPath(realDirs: string[], file: string): Promise<string | null> {
  const dir = realDirs[realDirs.length - 1];
  try {
    for (const d of realDirs) if (!(await lstat(d)).isDirectory()) return null;
    const entry = (await readdir(dir, { withFileTypes: true })).find((e) => e.isFile() && agentNameOfFile(e.name) === file);
    if (!entry) return null;
    const path = join(dir, entry.name);
    return (await lstat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

export function createAgentFileHandlers(deps: AgentFileDeps) {
  /** The path of a definition the current snapshot lists, or an error code. */
  const resolve = async (scope: unknown, projectId: unknown, file: unknown): Promise<{ path: string } | { error: AgentFileError }> => {
    const req = parseRequest(scope, projectId, file);
    if (!req) return { error: 'invalid-request' };
    const snap = await deps.snapshot();
    let realDirs: string[];
    if (req.scope === 'project') {
      const project = snap.projects.find((p) => p.id === req.projectId);
      if (!project?.agents.some((a) => a.file === req.file)) return { error: 'unknown-agent' };
      // `.claude` too: a repo that commits it as a link would point this at another folder.
      realDirs = [join(project.path, '.claude'), join(project.path, '.claude', 'agents')];
    } else {
      if (!snap.globalAgents.some((a) => a.file === req.file)) return { error: 'unknown-agent' };
      realDirs = [deps.globalAgentsDir];
    }
    const path = await definitionPath(realDirs, req.file);
    return path ? { path } : { error: 'not-a-file' };
  };

  return {
    async open(scope: unknown, projectId: unknown, file: unknown): Promise<AgentFileResult> {
      const found = await resolve(scope, projectId, file);
      if ('error' in found) return { ok: false, error: found.error };
      const err = await deps.openPath(found.path);
      if (!err) return { ok: true };
      deps.log(`[agents] could not open ${found.path}: ${err}`);
      return { ok: false, error: 'open-failed' };
    },

    /** The panel asked the person first. The file stays recoverable from the OS trash. */
    async trash(scope: unknown, projectId: unknown, file: unknown): Promise<AgentFileResult> {
      const found = await resolve(scope, projectId, file);
      if ('error' in found) return { ok: false, error: found.error };
      try {
        await deps.trashItem(found.path);
      } catch (e) {
        deps.log(`[agents] could not trash ${found.path}: ${e instanceof Error ? e.message : String(e)}`);
        return { ok: false, error: 'trash-failed' };
      }
      // The file is gone either way; a failed rescan only leaves the list stale until the next one.
      await deps.rescan().catch((e: unknown) => deps.log(`[agents] rescan after trash failed: ${e instanceof Error ? e.message : String(e)}`));
      return { ok: true };
    }
  };
}

export function registerAgentFileIpc(handlers: ReturnType<typeof createAgentFileHandlers>): void {
  ipcMain.handle('agents:open', (_evt, scope: unknown, projectId: unknown, file: unknown) => handlers.open(scope, projectId, file));
  ipcMain.handle('agents:trash', (_evt, scope: unknown, projectId: unknown, file: unknown) => handlers.trash(scope, projectId, file));
}
