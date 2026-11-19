import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { useProjects } from '@/store/projects';
import type { Project } from '@shared/project';
import { floorSpec, floorSpecKey, placementSignature, type FloorSpec } from './projectFloorSpec';

/** How long an unticked project's room stays, fading dark, before the floor
 *  drops it: the lights tick (0.5 s) plus the fade (0.6 s), with margin. */
export const LEAVE_FADE_MS = 1200;
/** Longest wait for the project list before building the floor anyway. */
const LOAD_WAIT_MS = 2000;
/** Scene key while the project list is still loading: the scene waits. */
export const FLOOR_PENDING = 'pending';

export interface ProjectFloorState {
  /** False: render the classic floor (no workspace, or the user chose classic). */
  active: boolean;
  /** Changes only when rooms are added, removed or resized: the scene rebuild key.
   *  FLOOR_PENDING until the project list is known. */
  key: string;
  /** Read inside the scene at build time. */
  specRef: { current: FloorSpec };
  /** Ticked projects with their paths, for seating agents by working folder. */
  tickedRef: { current: Pick<Project, 'id' | 'path'>[] };
  /** Rooms of projects just unticked, shown dark until the rebuild. */
  leavingRef: { current: Set<string> };
}

const ticked = (projects: Project[]) => projects.filter((p) => p.enabled).map((p) => ({ id: p.id, path: p.path }));

export function useProjectFloor(): ProjectFloorState {
  const snapshot = useProjects((s) => s.snapshot);
  const loaded = useProjects((s) => s.loaded);
  const floorMode = useProjects((s) => s.floorMode);
  // Re-render only when an agent is added, removed, archived or moves folder,
  // not on every status tick: those are the only changes that move rooms.
  const placement = useStore((s) => placementSignature(s.agents));
  const active = floorMode === 'projects' && !!snapshot.workspaceRoot;

  // The classic floor never needs the project list, so it never waits for it.
  const [waitedLong, setWaitedLong] = useState(false);
  useEffect(() => {
    if (loaded || floorMode === 'classic') return;
    const timer = window.setTimeout(() => setWaitedLong(true), LOAD_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, floorMode]);
  const ready = loaded || waitedLong || floorMode === 'classic';

  const wanted = useMemo(
    () => floorSpec(snapshot.projects, useStore.getState().agents),
    // `placement` stands for the agents: it changes whenever their rooms can.
    [snapshot.projects, placement]
  );
  const wantedKey = `${snapshot.workspaceRoot ?? ''}#${floorSpecKey(wanted)}`;
  const [shownKey, setShownKey] = useState(wantedKey);
  const specRef = useRef<FloorSpec>(wanted);
  const tickedRef = useRef(ticked(snapshot.projects));
  const leavingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const removed = specRef.current.projects.filter((p) => !wanted.projects.some((w) => w.id === p.id)).map((p) => p.id);
    const apply = () => {
      leavingRef.current = new Set();
      specRef.current = wanted;
      tickedRef.current = ticked(snapshot.projects);
      setShownKey(wantedKey);
    };
    if (removed.length === 0) { apply(); return; }
    leavingRef.current = new Set(removed);
    const timer = window.setTimeout(apply, LEAVE_FADE_MS);
    return () => window.clearTimeout(timer);
    // Keyed on `wantedKey` on purpose: `wanted` and `snapshot` are read for the
    // same render that produced the key.
  }, [wantedKey]);

  // The key lags only while a removed room fades out; otherwise it follows the
  // wanted floor in the same render, so the scene builds once, not twice.
  const fading = specRef.current.projects.some((p) => !wanted.projects.some((w) => w.id === p.id));
  const floorKey = fading ? shownKey : wantedKey;
  const key = !ready ? FLOOR_PENDING : active ? floorKey : 'classic';
  return { active, key, specRef, tickedRef, leavingRef };
}
