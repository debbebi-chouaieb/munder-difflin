import { useTranslation } from 'react-i18next';
import type { AgentDefinition } from '@shared/agentDefinition';
import { heading, muted } from './roomStyles';

/**
 * The project's own agents from `.claude/agents` (ADR 0009): name and model, the
 * description as a tooltip. Values come from the repo, already cleaned in the
 * snapshot; each keeps its own direction (`dir="auto"`).
 */
export function RoomAgentList({ agents }: { agents: AgentDefinition[] }) {
  const { t } = useTranslation();
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h3 style={heading}>{t('room.agents.title')}</h3>
      {agents.length === 0 ? (
        <p style={muted}>{t('projectSidebar.noAgents')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {agents.map((a) => (
            <li key={a.file} title={a.description ?? undefined} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span dir="auto" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
                {a.name}
              </span>
              {a.model && <span style={{ ...muted, flexShrink: 0 }}><bdi>{a.model}</bdi></span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
