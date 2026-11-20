import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '@shared/sessionList';
import { PixelButton } from '../PixelButton';
import { formatTokens } from './roomPanelModel';
import { heading, muted } from './roomStyles';

/**
 * The project's recent Claude sessions. Titles come from transcripts: plain
 * text only, with their own direction (`dir="auto"`) so an English title reads
 * right in the Arabic layout and the other way round.
 */
export function RoomSessionList({ sessions, errorKey, disabled, onOpen }: {
  sessions: SessionSummary[] | null;
  errorKey: string | null;
  disabled: boolean;
  /** null starts a new session. */
  onOpen: (sessionId: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 style={heading}>{t('room.sessions.title')}</h3>
        <PixelButton size="sm" variant="primary" disabled={disabled} onClick={() => onOpen(null)}>
          {t('room.sessions.new')}
        </PixelButton>
      </div>
      {errorKey && <p style={muted}>{t(errorKey)}</p>}
      {!errorKey && sessions === null && <p style={muted}>{t('room.loading')}</p>}
      {!errorKey && sessions?.length === 0 && <p style={muted}>{t('room.sessions.empty')}</p>}
      {sessions && sessions.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sessions.map((s) => (
            <li key={s.id}>
              <button type="button" disabled={disabled} onClick={() => onOpen(s.id)} title={s.title} style={row}>
                <span dir="auto" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'start' }}>
                  {s.title || t('room.sessions.untitled')}
                </span>
                <span style={{ flexShrink: 0, color: s.large ? 'var(--cth-coral)' : 'var(--cth-ink-500)' }}>
                  <bdi>{s.contextTokens === null ? '—' : formatTokens(s.contextTokens)}</bdi>
                  {s.large ? ` ${t('room.sessions.large')}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const row = {
  width: '100%', display: 'flex', gap: 8, alignItems: 'center', textAlign: 'start',
  padding: '4px 6px', border: 0, background: 'transparent', cursor: 'pointer',
  font: 'inherit', fontSize: 12, color: 'var(--cth-ink-900)'
} as const;
