/**
 * Renderer copy of the workspace projects (ADR 0001). Main owns the data; this
 * store mirrors `projects:list` and every `projects:changed` push, and keeps the
 * sidebar's own view state (open or hidden, width) per viewer in localStorage.
 */
import { create } from 'zustand';
import type { ProjectResult, ProjectsSnapshot } from '@shared/project';
import { PROJECT_SIDEBAR_DEFAULT_WIDTH, clampProjectSidebarWidth } from './projectSidebar';

const LS_COLLAPSED = 'cth.projectSidebarCollapsed';
const LS_WIDTH = 'cth.projectSidebarWidth';
const LS_FLOOR_MODE = 'cth.floorMode';

export type FloorMode = 'projects' | 'classic';

function readFloorMode(): FloorMode {
  try { return window.localStorage.getItem(LS_FLOOR_MODE) === 'classic' ? 'classic' : 'projects'; } catch { return 'projects'; }
}

interface ProjectsState {
  snapshot: ProjectsSnapshot;
  loaded: boolean;
  /** Last failed action, shown under the header until the next action. */
  actionError: string | null;
  collapsed: boolean;
  width: number;
  setCollapsed: (collapsed: boolean) => void;
  /** 'projects': the generated floor once a workspace is picked (default);
   *  'classic': the configured office theme. Switching never closes agents. */
  floorMode: FloorMode;
  setFloorMode: (mode: FloorMode) => void;
  setWidth: (px: number) => void;
  /** Pulls the snapshot and follows pushes. Returns the unsubscribe function. */
  connect: () => () => void;
  pickWorkspace: () => Promise<void>;
  rescan: () => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  setParallel: (id: string, parallel: boolean) => Promise<void>;
  setZetahubKey: (id: string, key: string | null) => Promise<void>;
  /** The room's ZetaHub section on or off; null returns it to auto. */
  setShowZetahub: (id: string, show: boolean | null) => Promise<void>;
}

function readBool(key: string): boolean {
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}

function readWidth(): number {
  try {
    const raw = window.localStorage.getItem(LS_WIDTH);
    return raw === null ? PROJECT_SIDEBAR_DEFAULT_WIDTH : clampProjectSidebarWidth(Number(raw));
  } catch {
    return PROJECT_SIDEBAR_DEFAULT_WIDTH;
  }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* private window: per-session only */ }
}

const EMPTY: ProjectsSnapshot = { workspaceRoot: null, projects: [], globalAgents: [] };

export const useProjects = create<ProjectsState>((set) => {
  /** Applies an action's result; the push usually lands first, this covers a missed one. */
  const apply = async (action: () => Promise<ProjectResult>): Promise<void> => {
    try {
      const res = await action();
      if (res.ok) set({ snapshot: res.snapshot, loaded: true, actionError: null });
      // A cancelled dialog is a choice, not a failure: it also clears an old error.
      else set({ actionError: res.error === 'cancelled' ? null : res.error });
    } catch (e) {
      set({ actionError: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    snapshot: EMPTY,
    loaded: false,
    actionError: null,
    collapsed: readBool(LS_COLLAPSED),
    floorMode: readFloorMode(),
    setFloorMode: (floorMode) => {
      write(LS_FLOOR_MODE, floorMode);
      set({ floorMode });
    },
    width: readWidth(),
    setCollapsed: (collapsed) => {
      write(LS_COLLAPSED, collapsed ? '1' : '0');
      set({ collapsed });
    },
    setWidth: (px) => {
      const width = clampProjectSidebarWidth(px);
      write(LS_WIDTH, String(width));
      set({ width });
    },
    connect: () => {
      const off = window.cth.onProjectsChanged((snapshot) => set({ snapshot, loaded: true }));
      window.cth.listProjects()
        .then((snapshot) => set({ snapshot, loaded: true }))
        // Stay not-loaded: "No workspace yet" would be a wrong claim when the
        // list simply could not be fetched. The error banner says what happened.
        .catch((e: unknown) => set({ actionError: e instanceof Error ? e.message : String(e) }));
      return off;
    },
    pickWorkspace: () => apply(() => window.cth.pickWorkspace()),
    rescan: () => apply(async () => ({ ok: true, snapshot: await window.cth.rescanProjects() })),
    setEnabled: (id, enabled) => apply(() => window.cth.setProjectEnabled(id, enabled)),
    setParallel: (id, parallel) => apply(() => window.cth.setProjectParallel(id, parallel)),
    setZetahubKey: (id, key) => apply(() => window.cth.setProjectZetahubKey(id, key)),
    setShowZetahub: (id, show) => apply(() => window.cth.setProjectShowZetahub(id, show))
  };
});
