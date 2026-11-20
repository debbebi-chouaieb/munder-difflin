/**
 * Drag rules for SidebarSplitter, pure so they are unit-testable.
 */

export type PanelSide = 'left' | 'right';

/**
 * +1 when dragging right grows the panel, -1 when dragging left grows it.
 * A panel grows when its handle is dragged into the floor. `panelSide` is the side in a
 * left-to-right layout; a right-to-left layout mirrors the row, so both panels
 * swap sides and their rule flips.
 */
export function dragSign(panelSide: PanelSide, rtl: boolean): 1 | -1 {
  const drawnOnLeft = (panelSide === 'left') !== rtl;
  return drawnOnLeft ? 1 : -1;
}

/** Floor space each panel must leave: the floor never shrinks below this. */
export const MIN_FLOOR_WIDTH = 360;

/**
 * New panel width after a drag. `availableWidth` is the row width minus every
 * other panel, so two wide sidebars can never squeeze the floor away.
 */
export function nextPanelWidth(args: {
  startWidth: number;
  dragPx: number;
  sign: 1 | -1;
  min: number;
  max: number;
  availableWidth: number;
}): number {
  const clampMax = Math.min(args.max, Math.max(args.min, args.availableWidth - MIN_FLOOR_WIDTH));
  return Math.min(clampMax, Math.max(args.min, args.startWidth + args.dragPx * args.sign));
}
