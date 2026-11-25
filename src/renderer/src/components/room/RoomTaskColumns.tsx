import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalItem, RoomTickets, ZetahubRow } from '@shared/ticketSources';
import { formatSyncedAt, localColumns, zetahubColumns, type TaskColumn } from './roomPanelModel';
import { heading, muted } from './roomStyles';
import { PixelButton } from '../PixelButton';

const ACCENTS: Record<string, string> = {
  todo: 'var(--cth-sky)',
  doing: 'var(--cth-lemon)',
  review: 'var(--cth-lilac)',
  other: 'var(--cth-cream-300)',
  high: 'var(--cth-coral)',
  normal: 'var(--cth-mint)'
};

/**
 * The room's tasks as kanban columns, like the Tasks board: ZetaHub tickets
 * (from the local cache) by status, then local "No ticket yet" items by
 * priority. The ZetaHub section is left out when main hid it for this project.
 * Every value is plain text: ticket text can be written by any ZetaHub user and
 * local items by anyone with the repo. User text keeps its own direction
 * (`dir="auto"`); keys and counts are isolated (`<bdi>`).
 */
export function RoomTaskColumns({ tickets, errorKey, onUseKey }: {
  tickets: RoomTickets | null;
  errorKey: string | null;
  /** Saves a key the repo's CLAUDE.md suggested as the person's own (ADR 0010). */
  onUseKey: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
  if (errorKey) return <p style={muted}>{t(errorKey)}</p>;
  if (!tickets) return <p style={muted}>{t('room.loading')}</p>;
  const { zetahub, local } = tickets;
  const zetahubHidden = !zetahub.ok && zetahub.reason === 'hidden';
  return (
    <>
      {!zetahubHidden && (
        <section style={section}>
          <h3 style={heading}>
            {t('room.tickets.zetahub')}
            {zetahub.ok && <> · <bdi>{zetahub.key}</bdi> (<bdi>{zetahub.total}</bdi>)</>}
          </h3>
          {zetahub.ok ? (
            <>
              {zetahub.syncedAt && (
                <p style={muted}>{t('room.tickets.syncedAt', { time: formatSyncedAt(zetahub.syncedAt, i18n.language) })}</p>
              )}
              <Columns columns={zetahubColumns(zetahub.rows)} itemKey={(r) => r.key} renderCard={(r, colId) => <ZetahubCard row={r} showStatus={colId === 'other'} />} />
              {zetahub.total > zetahub.rows.length && (
                <p style={muted}>{t('room.tickets.more', { count: zetahub.total - zetahub.rows.length })}</p>
              )}
              <p style={muted}>{t('room.tickets.refreshHint')}</p>
            </>
          ) : zetahub.reason === 'suggested' && zetahub.key ? (
            <SuggestedKey zetahubKey={zetahub.key} onUse={onUseKey} />
          ) : (
            <p style={muted}>{t(`room.tickets.zetahubReason.${zetahub.reason}`)}</p>
          )}
        </section>
      )}
      <section style={section}>
        <h3 style={heading}>{t('room.tickets.local')}{local.ok && <> (<bdi>{local.total}</bdi>)</>}</h3>
        {local.ok ? (
          <Columns columns={localColumns(local.items)} itemKey={(_item, i) => String(i)} renderCard={(item) => <LocalCard item={item} />} />
        ) : (
          <p style={muted}>{t(`room.tickets.localReason.${local.reason}`)}</p>
        )}
        {local.ok && local.total > local.items.length && (
          <p style={muted}>{t('room.tickets.more', { count: local.total - local.items.length })}</p>
        )}
      </section>
    </>
  );
}

/** A key from the repo's CLAUDE.md: shown, never read, until the person takes it. */
function SuggestedKey({ zetahubKey, onUse }: { zetahubKey: string; onUse: (key: string) => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <p style={{ ...muted, flex: '1 1 200px' }}>
        {t('room.tickets.suggestedKey.body')} <bdi style={cardKey}>{zetahubKey}</bdi>
      </p>
      <PixelButton size="sm" title={t('room.tickets.suggestedKey.hint')} onClick={() => onUse(zetahubKey)}>{t('room.tickets.suggestedKey.use')}</PixelButton>
    </div>
  );
}

function Columns<T>({ columns, itemKey, renderCard }: {
  columns: TaskColumn<T>[];
  itemKey: (item: T, index: number) => string;
  renderCard: (item: T, columnId: string) => ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
      {columns.map((col) => (
        <div key={col.id} style={{
          flex: '1 1 0', minWidth: 130, display: 'flex', flexDirection: 'column',
          background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px 3px',
            background: ACCENTS[col.id], boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
          }}>
            {t(col.labelKey)}
            <span style={{ marginInlineStart: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}><bdi>{col.items.length}</bdi></span>
          </div>
          <div style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {col.items.length === 0 && <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '6px 0' }}>—</div>}
            {col.items.map((item, i) => (
              <div key={itemKey(item, i)} style={{ display: 'flex', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)' }}>
                <span style={{ width: 4, flexShrink: 0, background: ACCENTS[col.id] }} />
                <span style={{ flex: 1, minWidth: 0, padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {renderCard(item, col.id)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** `showStatus`: the Other column mixes statuses, so each card names its own. */
function ZetahubCard({ row, showStatus }: { row: ZetahubRow; showStatus: boolean }) {
  return (
    <>
      <span style={cardKey}><bdi>{row.key}</bdi>{row.priority && <> · <bdi>{row.priority}</bdi></>}</span>
      <span style={cardTitle} dir="auto" title={row.title}>{row.title}</span>
      {showStatus && <span style={cardMeta} dir="auto">{row.status}</span>}
      {row.assignee && <span style={cardMeta} dir="auto">{row.assignee}</span>}
    </>
  );
}

function LocalCard({ item }: { item: LocalItem }) {
  return (
    <>
      <span style={cardTitle} dir="auto" title={item.text}>{item.text}</span>
      {item.source && <span style={cardMeta}><bdi>{item.source}</bdi></span>}
    </>
  );
}

const section = { display: 'flex', flexDirection: 'column', gap: 6 } as const;
const cardKey = { fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)' } as const;
const cardTitle = {
  fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-900)', overflowWrap: 'anywhere',
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
} as const;
const cardMeta = { fontSize: 10, color: 'var(--cth-ink-500)', overflowWrap: 'anywhere' } as const;
