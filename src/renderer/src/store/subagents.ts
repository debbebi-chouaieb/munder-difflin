/**
 * Subagents each live session is running right now (ADR 0014). Fed from the
 * `hive:hookEvent` stream; display-only, so a reload starts empty.
 */
import { create } from 'zustand';
import { withSubagentEvent, type RunningSubagents, type SubagentEvent } from '@shared/subagentActivity';

interface SubagentsState {
  running: RunningSubagents;
  apply: (e: SubagentEvent) => void;
}

export const useSubagents = create<SubagentsState>((set) => ({
  running: {},
  apply: (e) => set((s) => {
    const running = withSubagentEvent(s.running, e);
    return running === s.running ? s : { running };
  })
}));
