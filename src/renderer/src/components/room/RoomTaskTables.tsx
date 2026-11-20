import { useTranslation } from 'react-i18next';
import type { RoomTickets } from '@shared/ticketSources';
import { formatSyncedAt } from './roomPanelModel';
import { heading, muted } from './roomStyles';

/**
 * ZetaHub tickets (from the local cache) and local "No ticket yet" items, one
 * table per source. Every value is plain text: ticket text can be written by
 * any ZetaHub user and local items by anyone with the repo. User text keeps its
 * own direction (`dir="auto"`); keys and counts are isolated (`<bdi>`).
 */
export function RoomTaskTables({ tickets, errorKey }: { tickets: RoomTickets | null; errorKey: string | null }) {
  const { t, i18n } = useTranslation();
  if (errorKey) return <p style={muted}>{t(errorKey)}</p>;
  if (!tickets) return <p style={muted}>{t('room.loading')}</p>;
  const { zetahub, local } = tickets;
  return (
    <>
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
            {zetahub.rows.length === 0 ? <p style={muted}>{t('room.tickets.none')}</p> : (
              <table style={table}>
                <colgroup><col style={{ width: '22%' }} /><col /><col style={{ width: '24%' }} /></colgroup>
                <thead>
                  <tr>
                    <th style={th}>{t('room.tickets.key')}</th>
                    <th style={th}>{t('room.tickets.titleCol')}</th>
                    <th style={th}>{t('room.tickets.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {zetahub.rows.map((r) => (
                    <tr key={r.key}>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}><bdi>{r.key}</bdi></td>
                      <td style={td} dir="auto" title={r.assignee ?? undefined}>{r.title}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }} dir="auto">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {zetahub.total > zetahub.rows.length && (
              <p style={muted}>{t('room.tickets.more', { count: zetahub.total - zetahub.rows.length })}</p>
            )}
            <p style={muted}>{t('room.tickets.refreshHint')}</p>
          </>
        ) : (
          <p style={muted}>{t(`room.tickets.zetahubReason.${zetahub.reason}`)}</p>
        )}
      </section>
      <section style={section}>
        <h3 style={heading}>{t('room.tickets.local')}{local.ok && <> (<bdi>{local.total}</bdi>)</>}</h3>
        {local.ok ? (
          local.items.length === 0 ? <p style={muted}>{t('room.tickets.none')}</p> : (
            <ul style={{ margin: 0, paddingInlineStart: 16, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
              {local.items.map((item, i) => (
                <li key={i} style={{ fontWeight: item.high ? 700 : 400 }}>
                  <span dir="auto">{item.text}</span>
                  {item.source && <span style={{ color: 'var(--cth-ink-500)' }}> (<bdi>{item.source}</bdi>)</span>}
                </li>
              ))}
            </ul>
          )
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

const section = { display: 'flex', flexDirection: 'column', gap: 6 } as const;
const table = { width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' } as const;
const th = {
  textAlign: 'start', padding: '2px 4px', color: 'var(--cth-ink-500)', fontWeight: 400,
  borderBottom: '1px solid var(--cth-ink-300)'
} as const;
const td = { padding: '3px 4px', verticalAlign: 'top', overflowWrap: 'anywhere', color: 'var(--cth-ink-900)' } as const;
