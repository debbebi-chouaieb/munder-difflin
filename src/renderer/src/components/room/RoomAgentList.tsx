import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDefinition } from '@shared/agentDefinition';
import type { Project } from '@shared/project';
import { useProjects } from '@/store/projects';
import { PixelButton } from '../PixelButton';
import { RoomTrashAgentDialog } from './RoomDialogs';
import { heading, muted, warning } from './roomStyles';
import { isLeadRow, leadOptions, leadRefOf, leadStatus, leadValueOf } from './roomAgentModel';
import { useAgentFileActions } from './useAgentFileActions';

const selectStyle = {
  padding: '3px 6px', background: 'var(--cth-paper-100)',
  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
  minWidth: 0, maxWidth: '100%'
} as const;

/**
 * The project's own agents from `.claude/agents` (ADR 0009) and the agent the
 * room's lead runs as (ADR 0015). Each row opens its file in the editor or sends it
 * to the trash. Values come from the repo, already cleaned in the snapshot; each
 * keeps its own direction (`dir="auto"`).
 */
export function RoomAgentList({ project, leadRunning, onNotice }: {
  project: Project;
  leadRunning: boolean;
  /** An i18n key for a failed file action, shown in the panel's notice line. */
  onNotice: (key: string) => void;
}) {
  const { t } = useTranslation();
  const globalAgents = useProjects((s) => s.snapshot.globalAgents);
  const setMainAgent = useProjects((s) => s.setMainAgent);
  const [trashing, setTrashing] = useState<AgentDefinition | null>(null);
  const files = useAgentFileActions('project', project.id, onNotice);

  const options = leadOptions(project, globalAgents);
  const status = leadStatus(project, globalAgents, leadRunning);

  const trash = (def: AgentDefinition) => {
    setTrashing(null);
    void files.trash(def.file);
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h3 style={heading}>{t('room.agents.title')}</h3>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span style={{ ...muted, flexShrink: 0 }}>{t('room.agents.leadLabel')}</span>
        <select
          value={leadValueOf(project.mainAgent)}
          onChange={(e) => void setMainAgent(project.id, leadRefOf(e.target.value, options))}
          style={{ ...selectStyle, flex: 1 }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.group === 'default'
                ? t(status.defaultLabelKey, { name: project.settingsAgent ?? '' })
                : o.group === 'missing'
                  ? t('room.agents.leadOptionMissing', { name: o.name })
                  : o.group === 'global' ? t('room.agents.leadOptionGlobal', { name: o.name }) : o.name}
            </option>
          ))}
        </select>
      </label>
      {status.notes.map((n) => (
        <p key={n.key} style={n.warn ? warning : muted}>{t(n.key, { name: n.name ?? '' })}</p>
      ))}
      {project.agents.length === 0 ? (
        <p style={muted}>{t('projectSidebar.noAgents')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {project.agents.map((a) => (
            <li key={a.file} title={a.description ?? undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span dir="auto" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
                {a.name}
              </span>
              {isLeadRow(status.agent, a) && <span style={{ ...muted, flexShrink: 0 }}>{t('room.agents.leadBadge')}</span>}
              {a.model && <span style={{ ...muted, flexShrink: 0 }}><bdi>{a.model}</bdi></span>}
              <PixelButton size="sm" variant="ghost" disabled={files.busy} title={t('room.agents.openTitle')} onClick={() => void files.open(a.file)}>
                {t('room.agents.open')}
              </PixelButton>
              <PixelButton size="sm" variant="ghost" disabled={files.busy} title={t('room.agents.trashTitle')} onClick={() => setTrashing(a)}>
                {t('room.agents.trash')}
              </PixelButton>
            </li>
          ))}
        </ul>
      )}
      {trashing && (
        <RoomTrashAgentDialog
          name={trashing.name}
          leadNote={isLeadRow(status.agent, trashing) ? t('room.agents.trashLead') : null}
          onConfirm={() => trash(trashing)}
          onCancel={() => setTrashing(null)}
        />
      )}
    </section>
  );
}
