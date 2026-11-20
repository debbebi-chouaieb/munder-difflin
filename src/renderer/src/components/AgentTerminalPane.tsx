import { PtyTerminalView } from './PtyTerminalView';
import { terminalInstanceKey } from './terminalRecovery';
import { MessageQueueComposer } from './MessageQueueComposer';
import { useStore, type Agent } from '@/store/store';

/**
 * An agent's embedded terminal with its message composer: the agent panel's
 * terminal tab and the room panel's lead terminal. The caller checks that the
 * agent has a PTY and is not shown fullscreen, and owns the stream parser
 * (`usePtyParser`): it must outlive this pane, which unmounts on every tab
 * switch, or a pending idle flip would be cancelled.
 */
export function AgentTerminalPane({ agent, ptyId, onStreamData }: { agent: Agent; ptyId: string; onStreamData: (chunk: string) => void }) {
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <PtyTerminalView
          key={terminalInstanceKey(ptyId, agent.terminalGeneration)}
          ptyId={ptyId}
          onStreamData={onStreamData}
          onUserPrompt={(text) => {
            updateAgent(agent.id, { lastPrompt: text });
            if (text.trim().toLowerCase() === '/clear') {
              updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
            }
            void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text });
          }}
          onToggleFullscreen={() => setFullscreen(agent.id)}
          fullscreen={false}
          embedded
        />
      </div>
      <MessageQueueComposer agent={agent} />
    </div>
  );
}
