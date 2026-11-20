import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { leadAgentIdFor, type OpenTerminalRequest } from '@shared/roomLead';
import type { SessionSummary } from '@shared/sessionList';
import type { RoomTickets } from '@shared/ticketSources';
import { cleanText } from '@shared/untrustedText';
import { PixelPanel } from '../PixelPanel';
import { PixelButton } from '../PixelButton';
import { Icon } from '../Icon';
import { disposeTerminal } from '../terminalPool';
import { useStore } from '@/store/store';
import { useProjects } from '@/store/projects';
import { useRoomPanel } from '@/store/roomPanel';
import { boardCounts } from '@/store/roomBoardCounts';
import { RoomSessionList } from './RoomSessionList';
import { RoomTaskTables } from './RoomTaskTables';
import { RoomLargeSessionDialog, RoomTrustDialog } from './RoomDialogs';
import { LeadTerminal } from './LeadTerminal';
import { muted, warning } from './roomStyles';
import { afterLargeAnswer, openStep, readErrorKey, roomErrorKey, withTrust, type OpenStep } from './roomPanelModel';

type Question = Extract<OpenStep, { kind: 'ask-trust' | 'confirm-large' }>;

const logError = (line: string): void => console.error(line);

/**
 * A project room in the right panel (ADR 0005): recent sessions, the lead's
 * terminal (started only when the person asks) and the project's tasks. App
 * mounts one instance per room (`key`), so a late answer never lands in another
 * room. Every call to main carries the project id only. Reads happen on open,
 * after the lead starts or stops, and on window focus; there is no polling.
 */
export function RoomPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  // Main serves rooms of ticked projects only; an unticked one reads as gone.
  const project = useProjects((s) => s.snapshot.projects.find((p) => p.id === projectId && p.enabled));
  // A lead can outlive its project's tick; it is still found by id, so it can be stopped.
  const leadId = useProjects((s) => {
    const p = s.snapshot.projects.find((x) => x.id === projectId);
    return p ? leadAgentIdFor(p) : null;
  });
  const projectShown = !!project;
  const leadRunning = useStore((s) => leadId !== null && s.agents.some((a) => a.id === leadId));
  const clearRoom = useRoomPanel((s) => s.clearRoom);

  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<RoomTickets | null>(null);
  const [ticketsError, setTicketsError] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: string; warn: boolean } | null>(null);

  // Loads can overlap (focus, then an open): only the newest one's answer is shown.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const [s, k] = await Promise.allSettled([window.cth.roomSessions(projectId), window.cth.roomTickets(projectId)]);
    if (seq !== loadSeq.current) return;
    setSessionsError(readErrorKey(`sessions of ${projectId}`, s, logError));
    if (s.status === 'fulfilled' && s.value.ok) setSessions(s.value.sessions);
    setTicketsError(readErrorKey(`tickets of ${projectId}`, k, logError));
    if (k.status === 'fulfilled' && k.value.ok) {
      setTickets(k.value.tickets);
      useRoomPanel.getState().setCounts(projectId, boardCounts(k.value.tickets));
    }
  }, [projectId]);

  /** `load` with its failure logged: callers fire and forget. */
  const reload = useCallback(async () => {
    try {
      await load();
    } catch (e) {
      logError(`[room] load of ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [load, projectId]);

  useEffect(() => {
    if (!projectShown) return; // main refuses reads for an unticked project
    void reload();
    const onFocus = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload, projectShown]);

  const open = async (request: OpenTerminalRequest) => {
    setBusy(true);
    setNotice(null);
    try {
      const step = openStep(request, await window.cth.roomOpenTerminal(projectId, request));
      if (step.kind === 'failed') setNotice({ key: step.errorKey, warn: true });
      else if (step.kind === 'opened') {
        if (step.trustNotSaved) setNotice({ key: 'room.trust.notSaved', warn: true });
        void reload();
      } else setQuestion(step);
    } catch (e) {
      logError(`[room] open terminal for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
      setNotice({ key: roomErrorKey('spawn-failed'), warn: true });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setNotice(null);
    // Read before the card is archived: the pooled xterm of this lead must go too,
    // or the next open of the same lead id would reuse its old screen and draft.
    const ptyId = useStore.getState().agents.find((a) => a.id === leadId)?.ptyId;
    try {
      const res = await window.cth.roomCloseTerminal(projectId);
      if (!res.ok) setNotice({ key: roomErrorKey(res.error), warn: true });
      else {
        if (ptyId) disposeTerminal(ptyId);
        if (project) void reload();
      }
    } catch (e) {
      logError(`[room] close terminal for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
      setNotice({ key: roomErrorKey('stop-failed'), warn: true });
    } finally {
      setBusy(false);
    }
  };

  const answer = (next: OpenTerminalRequest) => { setQuestion(null); void open(next); };

  const stopButton = leadRunning && (
    <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>{t('room.terminal.stop')}</PixelButton>
  );
  const noticeLine = notice && (
    <p role="alert" style={{ ...(notice.warn ? warning : muted), padding: '6px 12px' }}>{t(notice.key)}</p>
  );

  if (!project) {
    return (
      <PixelPanel variant="default" noPadding style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={muted}>{t('room.gone')}</p>
        {noticeLine}
        <div style={{ display: 'flex', gap: 8 }}>
          {stopButton}
          <PixelButton size="sm" variant="ghost" onClick={clearRoom}>{t('room.close')}</PixelButton>
        </div>
      </PixelPanel>
    );
  }

  return (
    <PixelPanel variant="default" noPadding style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--cth-ink-300)' }}>
        <h2 dir="auto" style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
          {cleanText(project.name, 120) ?? project.id}
        </h2>
        {stopButton}
        <PixelButton size="sm" variant="ghost" onClick={clearRoom} title={t('room.close')}>
          <Icon name="x" />
        </PixelButton>
      </header>
      {noticeLine}
      <div style={{
        flex: leadRunning ? '0 1 auto' : 1, maxHeight: leadRunning ? '40%' : undefined, minHeight: 0, overflowY: 'auto',
        padding: 12, display: 'flex', flexDirection: 'column', gap: 16
      }}>
        {/* A running lead keeps its session: main re-announces it rather than switching. */}
        {leadRunning && <p style={muted}>{t('room.sessions.leadRunning')}</p>}
        <RoomSessionList
          sessions={sessions}
          errorKey={sessionsError}
          disabled={busy || leadRunning}
          onOpen={(sessionId) => void open({ sessionId })}
        />
        <RoomTaskTables tickets={tickets} errorKey={ticketsError} />
      </div>
      {leadRunning && leadId && (
        <div style={{ flex: 1, minHeight: 220, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--cth-ink-300)' }}>
          <LeadTerminal agentId={leadId} />
        </div>
      )}
      {question?.kind === 'ask-trust' && (
        <RoomTrustDialog
          projectName={project.name}
          path={question.path}
          claudeTrusts={question.claudeTrusts}
          onAnswer={(a) => answer(withTrust(question.request, a, question.path))}
          onCancel={() => setQuestion(null)}
        />
      )}
      {question?.kind === 'confirm-large' && (
        <RoomLargeSessionDialog
          contextTokens={question.contextTokens}
          onAnswer={(a) => answer(afterLargeAnswer(question.request, a))}
          onCancel={() => setQuestion(null)}
        />
      )}
    </PixelPanel>
  );
}
