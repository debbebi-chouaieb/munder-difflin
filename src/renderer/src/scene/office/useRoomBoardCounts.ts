import { useEffect, useMemo } from 'react';
import { useProjects } from '@/store/projects';
import { useRoomPanel } from '@/store/roomPanel';

/**
 * Keeps the rooms' ticket-count boards current (ADR 0005): reads every ticked
 * project's counts when the Projects floor is shown or its rooms change, and on
 * window focus. No polling: the ZetaHub cache only changes on /zetahub-sync.
 */
export function useRoomBoardCounts(active: boolean): void {
  const projects = useProjects((s) => s.snapshot.projects);
  const idsKey = useMemo(() => projects.filter((p) => p.enabled).map((p) => p.id).join('\n'), [projects]);

  useEffect(() => {
    if (!active || !idsKey) return;
    const ids = idsKey.split('\n');
    const refresh = () => { void useRoomPanel.getState().refreshCounts(ids); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [active, idsKey]);
}
