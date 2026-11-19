import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useProjects } from '@/store/projects';
import { groupAgents, projectErrorKey, workspaceLabel, type SidebarAgent } from '@/store/projectSidebar';
import { useRtl } from '@/i18n/useDirection';
import type { ProjectsSnapshot } from '@shared/project';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { ProjectRow } from '@/components/ProjectRow';

/**
 * Left project menu (ADR 0001, Phase 2): the CEO, the tech leads (global
 * agents) and one row per workspace project. Hidden, it leaves a single icon
 * that reopens it.
 */
export function ProjectSidebar() {
  const collapsed = useProjects((s) => s.collapsed);
  const setCollapsed = useProjects((s) => s.setCollapsed);
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <div style={{ flexShrink: 0, paddingInlineEnd: 8 }}>
        <PixelButton variant="ghost" size="sm" onClick={() => setCollapsed(false)} title={t('projectSidebar.show')}>
          <Icon name="sidebar" />
        </PixelButton>
      </div>
    );
  }
  return <ExpandedSidebar onHide={() => setCollapsed(true)} />;
}

function ExpandedSidebar({ onHide }: { onHide: () => void }) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const textDir = rtl ? 'auto' : undefined;
  const width = useProjects((s) => s.width);
  const snapshot = useProjects((s) => s.snapshot);
  const loaded = useProjects((s) => s.loaded);
  const actionError = useProjects((s) => s.actionError);
  const pickWorkspace = useProjects((s) => s.pickWorkspace);
  const rescan = useProjects((s) => s.rescan);
  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);

  const groups = useMemo(() => groupAgents(agents, snapshot.projects), [agents, snapshot.projects]);
  const root = snapshot.workspaceRoot;
  const rawError = actionError ?? snapshot.error ?? null;
  const errorKey = rawError ? projectErrorKey(rawError) : null;
  const ceo = groups.ceo;

  return (
    <PixelPanel noPadding style={{ width, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 8px 6px', borderBottom: '1px solid var(--cth-ink-300)' }}>
        <span
          title={root ?? undefined}
          dir={textDir}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}
        >
          {root ? workspaceLabel(root) : t('projectSidebar.workspace')}
        </span>
        {root && (
          <PixelButton variant="ghost" size="sm" onClick={() => void rescan()} title={t('projectSidebar.rescanTitle')}>
            {t('projectSidebar.rescan')}
          </PixelButton>
        )}
        {root && (
          <PixelButton variant="ghost" size="sm" onClick={() => void pickWorkspace()} title={t('projectSidebar.changeWorkspace')}>
            <Icon name="folder" />
          </PixelButton>
        )}
        <PixelButton variant="ghost" size="sm" onClick={onHide} title={t('projectSidebar.hide')}>
          <Icon name="sidebar" />
        </PixelButton>
      </div>

      {rawError && (
        <div role="alert" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--cth-coral)' }}>
          {errorKey ? t(errorKey) : rawError}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 8px' }}>
        <Section title={t('projectSidebar.ceo')}>
          {ceo ? (
            <button type="button" onClick={() => select(ceo.id)} style={rowButton}>
              <span aria-hidden="true">★ </span><span dir={textDir}>{ceo.name}</span>
            </button>
          ) : (
            <span style={muted}>—</span>
          )}
        </Section>

        <Section title={t('projectSidebar.techLeads')}>
          {snapshot.globalAgents.length === 0 ? (
            <span style={muted}>{t('projectSidebar.techLeadsEmpty')}</span>
          ) : (
            <ul style={{ margin: 0, padding: 0 }}>
              {snapshot.globalAgents.map((name) => (
                <li key={name} style={{ ...muted, listStyle: 'none' }} title={t('projectSidebar.techLeadTitle')}>
                  <span aria-hidden="true">○ </span>{name}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('projectSidebar.projects')}>
          {loaded && (
            <ProjectList snapshot={snapshot} onFloor={groups.byProject} onPick={() => void pickWorkspace()} onSelectAgent={select} />
          )}
        </Section>
      </div>
    </PixelPanel>
  );
}

function ProjectList({ snapshot, onFloor, onPick, onSelectAgent }: {
  snapshot: ProjectsSnapshot;
  onFloor: Record<string, SidebarAgent[]>;
  onPick: () => void;
  onSelectAgent: (id: string) => void;
}) {
  const { t } = useTranslation();
  const setEnabled = useProjects((s) => s.setEnabled);
  const setParallel = useProjects((s) => s.setParallel);
  const setZetahubKey = useProjects((s) => s.setZetahubKey);

  if (!snapshot.workspaceRoot) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 12 }}>{t('projectSidebar.emptyTitle')}</strong>
        <span style={muted}>{t('projectSidebar.emptyBody')}</span>
        <PixelButton variant="primary" size="sm" onClick={onPick}>{t('projectSidebar.pickWorkspace')}</PixelButton>
      </div>
    );
  }
  if (snapshot.projects.length === 0) return <span style={muted}>{t('projectSidebar.noProjects')}</span>;
  return (
    <ul style={{ margin: 0, padding: 0 }}>
      {snapshot.projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          onFloor={onFloor[project.id] ?? []}
          onToggleEnabled={(enabled) => void setEnabled(project.id, enabled)}
          onToggleParallel={(parallel) => void setParallel(project.id, parallel)}
          onSaveKey={(key) => void setZetahubKey(project.id, key)}
          onSelectAgent={onSelectAgent}
        />
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 12 }}>
      <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px', color: 'var(--cth-ink-500)', textTransform: 'uppercase' }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

const muted: CSSProperties = { fontSize: 12, color: 'var(--cth-ink-500)' };

const rowButton: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'inherit',
  fontSize: 13,
  textAlign: 'start'
};
