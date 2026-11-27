import { useState } from 'react';
import type { AgentFileResult } from '@shared/agentDefinition';
import type { AgentScope } from '@shared/mainAgent';

/**
 * Open and trash for agent definition files (ADR 0015), shared by the room panel
 * and the sidebar's Tech leads. Main builds the path from the key; a failure comes
 * back as an i18n key through `onNotice`. The caller asks before `trash`.
 */
export function useAgentFileActions(scope: AgentScope, projectId: string | null, onNotice: (key: string) => void) {
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<AgentFileResult>, failedKey: string) => {
    setBusy(true);
    try {
      const res = await action();
      if (!res.ok) onNotice(`room.agents.errors.${res.error}`);
    } catch (e) {
      // The IPC itself failed (main gone, handler threw): main logged nothing, so log here.
      console.error('[agents] agent file action failed:', e);
      onNotice(failedKey);
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    open: (file: string) => run(() => window.cth.openAgentFile(scope, projectId, file), 'room.agents.errors.open-failed'),
    trash: (file: string) => run(() => window.cth.trashAgentFile(scope, projectId, file), 'room.agents.errors.trash-failed')
  };
}
