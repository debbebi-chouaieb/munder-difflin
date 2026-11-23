import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nextRoomTopHeight, ROOM_TERMINAL_MIN_HEIGHT } from './roomPanelModel';

/**
 * Horizontal drag handle between the room's lists and the lead terminal.
 * Dragging up to the top hides the lists; a double click toggles between
 * hidden and the last open height (`onToggle`, shared with "Hide lists").
 * Arrow keys move it; Home hides the lists and End gives them the most room.
 */
export function RoomSplitter({ height, panelHeight, onChange, onToggle }: {
  height: number;
  /** Height the lists and the terminal share. */
  panelHeight: number;
  onChange: (px: number) => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const start = useRef<{ clientY: number; height: number } | null>(null);
  const [active, setActive] = useState(false);
  const max = Math.max(0, panelHeight - ROOM_TERMINAL_MIN_HEIGHT);

  useEffect(() => {
    if (!active) return;
    const onMove = (e: MouseEvent) => {
      if (start.current) onChange(nextRoomTopHeight(start.current.height, e.clientY - start.current.clientY, panelHeight));
    };
    const onUp = () => { start.current = null; setActive(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'ns-resize';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
  }, [active, panelHeight, onChange]);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('room.splitter')}
      aria-valuenow={height}
      aria-valuemin={0}
      aria-valuemax={max}
      tabIndex={0}
      title={t('room.splitter')}
      onMouseDown={(e) => {
        start.current = { clientY: e.clientY, height };
        setActive(true);
        e.preventDefault();
      }}
      onDoubleClick={onToggle}
      onKeyDown={(e) => {
        const target = e.key === 'Home' ? 0
          : e.key === 'End' ? max
          : e.key === 'ArrowUp' ? height - 24
          : e.key === 'ArrowDown' ? height + 24
          : null;
        if (target === null) return;
        e.preventDefault();
        onChange(nextRoomTopHeight(target, 0, panelHeight));
      }}
      style={{
        height: 8, flexShrink: 0, cursor: 'ns-resize', position: 'relative',
        background: active ? 'var(--cth-cream-300)' : 'transparent',
        borderTop: '1px solid var(--cth-ink-300)'
      }}
    >
      <div style={{
        position: 'absolute', left: '50%', top: 2, transform: 'translateX(-50%)',
        width: 24, height: 3, borderTop: '1px solid var(--cth-ink-900)', borderBottom: '1px solid var(--cth-ink-900)'
      }} />
    </div>
  );
}
