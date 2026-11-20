import { useTranslation } from 'react-i18next';
import { AgentTerminalPane } from '../AgentTerminalPane';
import { useStore } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';
import { muted } from './roomStyles';

/**
 * The project lead's terminal inside the room panel, mounted only once the lead
 * runs. It selects its own agent, so the lead's status ticks re-render this
 * pane and not the whole room. The pooled terminal requests a PTY redraw when
 * it attaches (terminalPool), so a lead started earlier shows its screen.
 */
export function LeadTerminal({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const fullscreen = useStore((s) => s.fullscreenAgentId === agentId);
  // Lives as long as the lead runs in this room, like the agent panel's parser.
  const onPtyStream = usePtyParser(agentId);

  if (!agent?.ptyId) return <p style={{ ...muted, padding: 12 }}>{t('room.terminal.starting')}</p>;
  if (fullscreen) return <p style={{ ...muted, padding: 12 }}>{t('agentDetail.fullscreenDesc')}</p>;
  return <AgentTerminalPane agent={agent} ptyId={agent.ptyId} onStreamData={onPtyStream} />;
}
