import { useEffect, useRef, useState } from 'react';
import { dragSign, nextPanelWidth, type PanelSide } from './splitterRules';

export interface SidebarSplitterProps {
  /** Current sidebar width in px. */
  width: number;
  /** Called with the new width (already clamped externally). */
  onChange: (px: number) => void;
  /** Width this panel and the floor share: the row width minus every OTHER
   *  panel, so the floor always keeps its minimum. */
  viewportWidth: number;
  min?: number;
  max?: number;
  /** Which side of the floor the panel sits on (see `dragSign`). */
  panelSide?: PanelSide;
  /** Width restored on double-click. */
  resetWidth?: number;
}

/**
 * Vertical drag handle between the floor canvas and a sidebar. Cursor +
 * pixel-stripe affordance.
 */
export function SidebarSplitter({
  width, onChange, viewportWidth, min = 320, max = 1200, panelSide = 'right', resetWidth = 420
}: SidebarSplitterProps) {
  const startRef = useRef<{ clientX: number; width: number; sign: 1 | -1 } | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!startRef.current) return;
      onChange(nextPanelWidth({
        startWidth: startRef.current.width,
        dragPx: e.clientX - startRef.current.clientX,
        sign: startRef.current.sign,
        min,
        max,
        availableWidth: viewportWidth
      }));
    };
    const onUp = () => {
      startRef.current = null;
      setActive(false);
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    if (active) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'ew-resize';
    }
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [active, viewportWidth, min, max, onChange]);

  return (
    <div
      onMouseDown={(e) => {
        const sign = dragSign(panelSide, document.documentElement.dir === 'rtl');
        startRef.current = { clientX: e.clientX, width, sign };
        setActive(true);
        e.preventDefault();
      }}
      onDoubleClick={() => onChange(resetWidth)}
      title="Drag to resize · double-click to reset"
      style={{
        width: 10,
        cursor: 'ew-resize',
        flexShrink: 0,
        position: 'relative',
        background: active ? 'var(--cth-cream-300)' : 'transparent'
      }}
    >
      {/* The visible 2px stripe with hash marks in the middle */}
      <div style={{
        position: 'absolute',
        top: 0, bottom: 0, left: 4,
        width: 2,
        background: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'
      }} />
      <div style={{
        position: 'absolute',
        top: '50%', left: 2, transform: 'translateY(-50%)',
        width: 6, height: 24,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between'
      }}>
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
        <span style={{ height: 2, background: 'var(--cth-ink-900)' }} />
      </div>
    </div>
  );
}
