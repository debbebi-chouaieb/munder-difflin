import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDefinition } from '@shared/agentDefinition';
import { useProjects } from '@/store/projects';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { runningText } from '@/components/ProjectRow';
import { RoomTrashAgentDialog } from '@/components/room/RoomDialogs';
import { roomsLedByGlobal } from '@/components/room/roomAgentModel';
import { useAgentFileActions } from '@/components/room/useAgentFileActions';
import { warning } from '@/components/room/roomStyles';

/**
 * The global agents (ADR 0013) in the sidebar's Tech leads section. Each row opens
 * its file in the editor or sends it to the trash (ADR 0015); a running subagent
 * lights its row (ADR 0014).
 */
export function TechLeadList({ agents, running, muted }: {
  agents: AgentDefinition[];
  /** Files of the global agents running as a subagent right now. */
  running: ReadonlySet<string>;
  muted: CSSProperties;
}) {
  const { t } = useTranslation();
  const projects = useProjects((s) => s.snapshot.projects);
  const [trashing, setTrashing] = useState<AgentDefinition | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const files = useAgentFileActions('global', null, setNotice);

  const act = (action: () => Promise<void>) => {
    setNotice(null);
    void action();
  };

  const ledRooms = trashing ? roomsLedByGlobal(projects, trashing.file) : 0;

  return (
    <>
      <ul style={{ margin: 0, padding: 0 }}>
        {agents.map((agent) => {
          const isRunning = running.has(agent.file);
          const about = agent.description ?? t('projectSidebar.techLeadTitle');
          return (
            <li
              key={agent.file}
              style={{ ...muted, listStyle: 'none', display: 'flex', alignItems: 'center', gap: 4, ...(isRunning ? runningText : {}) }}
              title={isRunning ? `${t('projectSidebar.subagentRunning')} ${about}` : about}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span aria-hidden="true">{isRunning ? '● ' : '○ '}</span><span dir="auto">{agent.name}</span>
                {agent.model && <> · <bdi>{agent.model}</bdi></>}
              </span>
              <PixelButton size="sm" variant="ghost" disabled={files.busy} title={t('room.agents.openTitle')}
                onClick={() => act(() => files.open(agent.file))}>
                <Icon name="edit" />
              </PixelButton>
              <PixelButton size="sm" variant="ghost" disabled={files.busy} title={t('room.agents.trashTitle')}
                onClick={() => { setNotice(null); setTrashing(agent); }}>
                <Icon name="x" />
              </PixelButton>
            </li>
          );
        })}
      </ul>
      {notice && <p role="status" style={{ ...warning, marginTop: 4 }}>{t(notice)}</p>}
      {trashing && (
        <RoomTrashAgentDialog
          name={trashing.name}
          leadNote={ledRooms > 0 ? t('projectSidebar.trashLeadRooms', { count: ledRooms }) : null}
          onConfirm={() => { const def = trashing; setTrashing(null); act(() => files.trash(def.file)); }}
          onCancel={() => setTrashing(null)}
        />
      )}
    </>
  );
}
