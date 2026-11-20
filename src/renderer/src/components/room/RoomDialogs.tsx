import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cleanText } from '@shared/untrustedText';
import { PixelPanel } from '../PixelPanel';
import { PixelButton } from '../PixelButton';
import { formatTokens } from './roomPanelModel';
import { warning } from './roomStyles';

/** Same layer as the app's other modals. */
const MODAL_Z = 500;
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
// Written as escapes so review can see them (as in shared/untrustedText.ts).
const FIRST_STRONG_ISOLATE = '\u2068';
const POP_DIRECTIONAL_ISOLATE = '\u2069';

/**
 * A modal question; the first action must be the safe one (Cancel). Focus moves
 * there on open, so a key typed into the terminal behind it cannot answer. Tab
 * stays inside, Escape cancels from anywhere, and focus returns on close.
 */
function Dialog({ title, onCancel, children, actions }: { title: string; onCancel: () => void; children: ReactNode; actions: ReactNode }) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onCancelRef = useRef(onCancel);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first action is always the safe one (Cancel).
    boxRef.current?.querySelector<HTMLElement>('[data-actions] button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancelRef.current(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const items = [...boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      const inside = boxRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus();
    };
  }, []);

  return createPortal(
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: MODAL_Z
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 480, maxWidth: '92vw' }}
      >
        <PixelPanel variant="dialog" noPadding>
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, lineHeight: '20px' }}>
            <h2 id={titleId} style={{ margin: 0, fontFamily: 'var(--cth-font-display)', fontSize: 11, lineHeight: '16px' }}>{title}</h2>
            {children}
            <div data-actions style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>{actions}</div>
          </div>
        </PixelPanel>
      </div>
    </div>,
    document.body
  );
}

/**
 * "Trust this project?" (ADR 0005). Trust stores this folder and opens the lead
 * with Claude's folder-trust prompt pre-accepted and auto mode on. Open without
 * trust opens it once without either. Folder names and paths come from disk, so
 * they are cleaned of control and bidi characters and isolated for RTL.
 */
export function RoomTrustDialog({ projectName, path, claudeTrusts, onAnswer, onCancel }: {
  projectName: string;
  path: string;
  claudeTrusts: boolean;
  onAnswer: (answer: 'yes' | 'no') => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // The name sits inside a sentence: isolate it so an RTL or LTR name cannot reorder the words around it.
  const name = `${FIRST_STRONG_ISOLATE}${cleanText(projectName, 120) ?? ''}${POP_DIRECTIONAL_ISOLATE}`;
  return (
    <Dialog
      title={t('room.trust.title')}
      onCancel={onCancel}
      actions={(
        <>
          <PixelButton variant="ghost" onClick={onCancel}>{t('room.trust.cancel')}</PixelButton>
          <PixelButton variant="secondary" onClick={() => onAnswer('yes')}>{t('room.trust.trust')}</PixelButton>
          <PixelButton variant="primary" onClick={() => onAnswer('no')}>{t('room.trust.openUntrusted')}</PixelButton>
        </>
      )}
    >
      <p style={{ margin: 0 }}>{t('room.trust.body', { name })}</p>
      <p style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere' }}>
        <bdi dir="ltr">{cleanText(path, 1000) ?? ''}</bdi>
      </p>
      <p style={{ margin: 0 }}>{t('room.trust.risk')}</p>
      <p style={{ margin: 0 }}>{t('room.trust.remembered')}</p>
      <p style={{ margin: 0 }}>{t(claudeTrusts ? 'room.trust.untrustedButClaudeTrusts' : 'room.trust.untrusted')}</p>
      {claudeTrusts && <p style={{ ...warning, fontSize: 13 }}>{t('room.trust.claudeTrustsWarning')}</p>}
    </Dialog>
  );
}

/** Resuming a session above the size limit costs a lot of context: ask, and offer a new session. */
export function RoomLargeSessionDialog({ contextTokens, onAnswer, onCancel }: {
  contextTokens: number | null;
  onAnswer: (answer: 'resume' | 'new') => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t('room.large.title')}
      onCancel={onCancel}
      actions={(
        <>
          <PixelButton variant="ghost" onClick={onCancel}>{t('room.large.cancel')}</PixelButton>
          <PixelButton variant="secondary" onClick={() => onAnswer('resume')}>{t('room.large.resume')}</PixelButton>
          <PixelButton variant="primary" onClick={() => onAnswer('new')}>{t('room.large.newSession')}</PixelButton>
        </>
      )}
    >
      <p style={{ margin: 0 }}>
        {contextTokens === null
          ? t('room.large.bodyUnknown')
          : t('room.large.body', { size: formatTokens(contextTokens) })}
      </p>
    </Dialog>
  );
}
