import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { leadAgentIdFor, type OpenTerminalRequest } from '@shared/roomLead';
import type { SessionSummary } from '@shared/sessionList';
import type { RoomTickets } from '@shared/ticketSources';
import { cleanText } from '@shared/untrustedText';
import { zetahubShown } from '@shared/project';
import { PixelPanel } from '../PixelPanel';
import { PixelButton } from '../PixelButton';
import { Icon } from '../Icon';
import { disposeTerminal } from '../terminalPool';
import { useStore } from '@/store/store';
import { useProjects } from '@/store/projects';
import { useRoomPanel } from '@/store/roomPanel';
import { boardCounts } from '@/store/roomBoardCounts';
import { RoomSessionList } from './RoomSessionList';
import { RoomTaskColumns } from './RoomTaskColumns';
import { RoomAgentList } from './RoomAgentList';
import { RoomSplitter } from './RoomSplitter';
import { RoomCapDialog, RoomLargeSessionDialog, RoomTrustDialog } from './RoomDialogs';
import { LeadTerminal } from './LeadTerminal';
import { muted, warning } from './roomStyles';
import {
  afterLargeAnswer, canForgetTrust, nextRoomTopHeight, openStep, readErrorKey, roomErrorKey, showZetahubSetting, withTrust, type OpenStep
} from './roomPanelModel';

type Question = Extract<OpenStep, { kind: 'ask-trust' | 'confirm-large' | 'confirm-cap' }>;

const logError = (line: string): void => console.error(line);

/** RoomSplitter's drawn height, taken from the body before the lists and terminal split it. */
const SPLITTER_HEIGHT = 8;

/**
 * A project room in the right panel (ADR 0005): recent sessions, the lead's
 * terminal (started only when the person asks), the project's tasks and its
 * agents (ADR 0009). App
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
  const storedTopHeight = useRoomPanel((s) => s.topHeight);
  const setTopHeight = useRoomPanel((s) => s.setTopHeight);
  const toggleLists = useRoomPanel((s) => s.toggleLists);
  const setShowZetahub = useProjects((s) => s.setShowZetahub);
  const setZetahubKey = useProjects((s) => s.setZetahubKey);
  // Re-read when a suggested key is accepted or the key changes: main reads by the saved key.
  const zetahubKeyState = project ? `${project.zetahubKeySource ?? ''}:${project.zetahubKey ?? ''}` : '';
  const showZetahub = project ? zetahubShown(project) : false;

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

  // Also re-reads when the ZetaHub section is turned on or off: main reads it only when shown.
  useEffect(() => {
    if (!projectShown) return; // main refuses reads for an unticked project
    void reload();
    const onFocus = () => { void reload(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      // A load still in flight belongs to a closed or changed room: drop its answer.
      loadSeq.current++;
    };
  }, [reload, projectShown, showZetahub, zetahubKeyState]);

  // The lists and the terminal share the body; its height bounds the splitter.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setBodyHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setBodyHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [projectShown]);
  const splitHeight = Math.max(0, bodyHeight - SPLITTER_HEIGHT);
  const topHeight = nextRoomTopHeight(storedTopHeight ?? Math.round(splitHeight * 0.4), 0, splitHeight);

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

  const forgetTrust = async () => {
    // No local trust state: the button goes when main pushes the snapshot without trust.
    setBusy(true);
    setNotice(null);
    try {
      const res = await window.cth.roomForgetTrust(projectId);
      setNotice(res.ok ? { key: 'room.trust.forgotten', warn: false } : { key: roomErrorKey(res.error), warn: true });
    } catch (e) {
      logError(`[room] forget trust for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
      setNotice({ key: roomErrorKey('forget-failed'), warn: true });
    } finally {
      setBusy(false);
    }
  };

  const answer = (next: OpenTerminalRequest) => { setQuestion(null); void open(next); };

  /** Stops the offered lead (and drops its pooled terminal), then retries the same open. */
  const stopOtherThenOpen = async (closeProjectId: string, request: OpenTerminalRequest) => {
    setQuestion(null);
    setBusy(true);
    try {
      const other = useProjects.getState().snapshot.projects.find((p) => p.id === closeProjectId);
      const otherPtyId = other ? useStore.getState().agents.find((a) => a.id === leadAgentIdFor(other))?.ptyId : undefined;
      const res = await window.cth.roomCloseTerminal(closeProjectId);
      if (!res.ok) {
        setNotice({ key: roomErrorKey(res.error), warn: true });
        return;
      }
      if (otherPtyId) disposeTerminal(otherPtyId);
    } catch (e) {
      logError(`[room] stop of ${closeProjectId} for a new terminal failed: ${e instanceof Error ? e.message : String(e)}`);
      setNotice({ key: roomErrorKey('stop-failed'), warn: true });
      return;
    } finally {
      setBusy(false);
    }
    await open(request);
  };

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
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={showZetahub}
            onChange={(e) => void setShowZetahub(project.id, showZetahubSetting(e.target.checked, project.zetahubKey !== null))}
          />
          {t('room.tickets.showZetahub')}
        </label>
        {leadRunning && (
          <PixelButton size="sm" variant="ghost" onClick={() => toggleLists(topHeight)}>
            {topHeight > 0 ? t('room.lists.hide') : t('room.lists.show')}
          </PixelButton>
        )}
        {canForgetTrust(project.trusted, leadRunning) && (
          <PixelButton size="sm" variant="ghost" disabled={busy} onClick={() => void forgetTrust()} title={t('room.trust.forgetHint')}>
            {t('room.trust.forget')}
          </PixelButton>
        )}
        {stopButton}
        <PixelButton size="sm" variant="ghost" onClick={clearRoom} title={t('room.close')}>
          <Icon name="x" />
        </PixelButton>
      </header>
      {noticeLine}
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          flex: leadRunning ? `0 0 ${topHeight}px` : 1, minHeight: 0, overflowY: 'auto',
          padding: leadRunning && topHeight === 0 ? 0 : 12, display: 'flex', flexDirection: 'column', gap: 16
        }}>
          {/* A running lead keeps its session: main re-announces it rather than switching. */}
          {leadRunning && <p style={muted}>{t('room.sessions.leadRunning')}</p>}
          <RoomSessionList
            sessions={sessions}
            errorKey={sessionsError}
            disabled={busy || leadRunning}
            onOpen={(sessionId) => void open({ sessionId })}
          />
          <RoomTaskColumns tickets={tickets} errorKey={ticketsError} onUseKey={(key) => void setZetahubKey(project.id, key)} />
          <RoomAgentList agents={project.agents} />
        </div>
        {leadRunning && leadId && (
          <>
            <RoomSplitter height={topHeight} panelHeight={splitHeight} onChange={setTopHeight} onToggle={() => toggleLists(topHeight)} />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <LeadTerminal agentId={leadId} />
            </div>
          </>
        )}
      </div>
      {question?.kind === 'ask-trust' && (
        <RoomTrustDialog
          projectName={project.name}
          path={question.path}
          claudeTrusts={question.claudeTrusts}
          onAnswer={(a) => answer(withTrust(question.request, a, question.path))}
          onCancel={() => setQuestion(null)}
        />
      )}
      {question?.kind === 'confirm-cap' && (
        <RoomCapDialog
          cap={question.cap}
          closeName={question.closeName}
          onConfirm={() => void stopOtherThenOpen(question.closeProjectId, question.request)}
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
