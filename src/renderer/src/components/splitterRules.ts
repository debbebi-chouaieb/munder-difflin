/**
 * Drag rules for SidebarSplitter, pure so they are unit-testable.
 */

export type PanelSide = 'left' | 'right';

/**
 * +1 when dragging right grows the panel, -1 when dragging left grows it.
 * The right-side agent panel keeps its original rule (drag left grows) in every
 * direction; the left-side project panel follows the page mirror, because in a
 * right-to-left layout it is drawn on the right.
 */
export function dragSign(panelSide: PanelSide, rtl: boolean): 1 | -1 {
  if (panelSide === 'right') return -1;
  return rtl ? -1 : 1;
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
