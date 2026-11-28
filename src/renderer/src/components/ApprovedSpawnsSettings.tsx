import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovedSpawn } from '@shared/spawnRecipe';
import { PixelButton } from './PixelButton';

const quoted = (arg: string): string => (arg === '' || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg);

/**
 * The commands confirmed in main's spawn dialog (ADR 0020). Main owns the list:
 * this only shows it and asks main to forget an entry, which needs no dialog.
 */
export function ApprovedSpawnsSettings() {
  const { t } = useTranslation();
  const [spawns, setSpawns] = useState<ApprovedSpawn[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.cth.getConfig()
      .then((cfg) => { if (live) setSpawns(cfg.approvedSpawns ?? []); })
      .catch((e: unknown) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, []);

  const forget = async (spawn: ApprovedSpawn): Promise<void> => {
    setError(null);
    try {
      const next = await window.cth.removeApprovedSpawn(spawn);
      setSpawns(next.approvedSpawns ?? []);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{t('settings.approvedSpawns.title')}</span>
      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{t('settings.approvedSpawns.desc')}</div>
      {spawns.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('settings.approvedSpawns.none')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {spawns.map((spawn) => (
            <div key={JSON.stringify([spawn.provider, spawn.argv])} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <code dir="ltr" style={{ fontSize: 12, color: 'var(--cth-ink-900)', wordBreak: 'break-all' }}>{spawn.argv.map(quoted).join(' ')}</code>
              <PixelButton variant="secondary" size="sm" onClick={() => void forget(spawn)}>{t('settings.approvedSpawns.forget')}</PixelButton>
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: 'var(--cth-danger, #6E1423)' }}>{error}</div>}
    </div>
  );
}
