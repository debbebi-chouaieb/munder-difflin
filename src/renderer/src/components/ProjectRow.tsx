import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '@shared/project';
import { keyDraftAction, type SidebarAgent } from '@/store/projectSidebar';
import { useRtl } from '@/i18n/useDirection';

export interface ProjectRowProps {
  project: Project;
  /** Agents on the floor whose working folder is in this project. */
  onFloor: SidebarAgent[];
  onToggleEnabled: (enabled: boolean) => void;
  onToggleParallel: (parallel: boolean) => void;
  onSaveKey: (key: string | null) => void;
  onSelectAgent: (id: string) => void;
}

const smallText: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)' };

/** One project: on/off checkbox, key badge, parallel switch, and its agents when expanded. */
export function ProjectRow({ project, onFloor, onToggleEnabled, onToggleParallel, onSaveKey, onSelectAgent }: ProjectRowProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const textDir = rtl ? 'auto' : undefined;
  const [open, setOpen] = useState(false);
  const closedArrow = rtl ? '◂' : '▸';

  return (
    <li style={{ listStyle: 'none', padding: '4px 0', opacity: project.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <input
          type="checkbox"
          checked={project.enabled}
          onChange={(e) => onToggleEnabled(e.target.checked)}
          aria-label={project.name}
          title={t('projectSidebar.enableTitle', { name: project.name })}
          style={{ margin: 0, flexShrink: 0 }}
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={project.path}
          style={{ ...plainButton, flex: 1, minWidth: 0, display: 'flex', gap: 4, alignItems: 'center' }}
        >
          <span aria-hidden="true" style={{ width: 10, flexShrink: 0 }}>{open ? '▾' : closedArrow}</span>
          <span dir={textDir} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
            {project.name}
          </span>
        </button>
        {onFloor.length > 0 && (
          <span style={smallText}>{t('projectSidebar.running', { count: onFloor.length })}</span>
        )}
        <ZetahubKeyBadge project={project} onSave={onSaveKey} />
      </div>

      {open && (
        <div style={{ paddingInlineStart: 34, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <label style={{ ...smallText, display: 'flex', alignItems: 'center', gap: 6 }} title={t('projectSidebar.parallelTitle')}>
            <input
              type="checkbox"
              checked={project.parallel}
              onChange={(e) => onToggleParallel(e.target.checked)}
              style={{ margin: 0 }}
            />
            {project.parallel ? t('projectSidebar.parallelOn') : t('projectSidebar.parallelOff')}
          </label>

          {onFloor.length > 0 && (
            <AgentList title={t('projectSidebar.runningAgents')}>
              {onFloor.map((agent) => (
                <li key={agent.id} style={{ listStyle: 'none' }}>
                  <button type="button" onClick={() => onSelectAgent(agent.id)} style={{ ...plainButton, fontSize: 12 }}>
                    <span aria-hidden="true">● </span><span dir={textDir}>{agent.name}</span>
                  </button>
                </li>
              ))}
            </AgentList>
          )}

          <AgentList title={t('projectSidebar.desks')}>
            {project.agents.length === 0 ? (
              <li style={{ ...smallText, listStyle: 'none' }}>{t('projectSidebar.noAgents')}</li>
            ) : (
              project.agents.map((name) => (
                <li key={name} style={{ ...smallText, listStyle: 'none' }} title={t('projectSidebar.deskTitle')}>
                  <span aria-hidden="true">○ </span>{name}
                </li>
              ))
            )}
          </AgentList>
        </div>
      )}
    </li>
  );
}

function AgentList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ ...smallText, fontWeight: 600 }}>{title}</div>
      <ul style={{ margin: 0, padding: 0 }}>{children}</ul>
    </div>
  );
}

/**
 * The ZetaHub key as a badge. Click to edit; Enter or leaving the field commits,
 * Escape cancels. Commits run once, and an unchanged key is not saved, so a key
 * read from CLAUDE.md never turns into a user setting by accident. An invalid
 * key keeps the field open on Enter and is dropped on blur.
 */
function ZetahubKeyBadge({ project, onSave }: { project: Project; onSave: (key: string | null) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);

  const open = () => {
    done.current = false;
    setInvalid(false);
    setDraft(project.zetahubKey ?? '');
  };
  const close = () => {
    done.current = true;
    setDraft(null);
  };
  const commit = (fromBlur: boolean) => {
    if (done.current || draft === null) return;
    const action = keyDraftAction(draft, project.zetahubKey);
    if (action === 'invalid') {
      if (fromBlur) close();
      else setInvalid(true);
      return;
    }
    if (action === 'save') onSave(draft.trim().toUpperCase());
    if (action === 'clear') onSave(null);
    close();
  };

  if (draft !== null) {
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') commit(false);
      if (e.key === 'Escape') close();
    };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => { setInvalid(false); setDraft(e.target.value.toUpperCase()); }}
        onKeyDown={onKey}
        onBlur={() => commit(true)}
        aria-label={t('projectSidebar.keyTitle')}
        aria-invalid={invalid}
        title={invalid ? t('projectSidebar.keyInvalid') : t('projectSidebar.keyTitle')}
        style={{
          width: 80,
          fontSize: 11,
          padding: '1px 4px',
          fontFamily: 'var(--cth-font-mono, monospace)',
          outline: invalid ? '2px solid var(--cth-coral)' : undefined
        }}
      />
    );
  }

  const fromFile = project.zetahubKeySource === 'claude-md';
  return (
    <button
      type="button"
      onClick={open}
      title={fromFile ? `${t('projectSidebar.keyFromClaudeMd')} · ${t('projectSidebar.keyTitle')}` : t('projectSidebar.keyTitle')}
      style={{
        ...plainButton,
        flexShrink: 0,
        fontSize: 10,
        padding: '0 4px',
        border: `1px ${fromFile ? 'dashed' : 'solid'} var(--cth-ink-300)`,
        fontFamily: 'var(--cth-font-mono, monospace)',
        color: project.zetahubKey ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
      }}
    >
      {project.zetahubKey ?? t('projectSidebar.keyAdd')}
    </button>
  );
}

const plainButton: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'start'
};
