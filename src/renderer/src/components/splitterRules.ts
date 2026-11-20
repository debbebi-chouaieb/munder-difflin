/**
 * Drag and fitting rules for the two sidebars around the floor, pure so they
 * are unit-testable.
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

/**
 * Floor space each panel must leave. Budgets are taken from the window width,
 * so the row padding and splitter handles come out of this margin: the drawn
 * floor is about 50 px narrower.
 */
export const MIN_FLOOR_WIDTH = 360;

/** Narrowest the right-hand agent panel may be drawn. */
export const AGENT_PANEL_MIN_WIDTH = 320;

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

/**
 * Widths to draw the two panels at, so the floor keeps MIN_FLOOR_WIDTH after a
 * window resize, a reopened project panel or restored widths, not only after a
 * drag. The stored widths are left alone: the panels grow back when space returns.
 * The agent panel gives way first, then the project panel, each down to its
 * minimum. A hidden project panel takes no width.
 */
export function fitPanelWidths(args: {
  viewportWidth: number;
  agentWidth: number;
  agentMin: number;
  projectWidth: number;
  projectMin: number;
  projectHidden: boolean;
}): { agent: number; project: number } {
  const project = args.projectHidden ? 0 : args.projectWidth;
  const overflow = args.agentWidth + project + MIN_FLOOR_WIDTH - args.viewportWidth;
  if (overflow <= 0) return { agent: args.agentWidth, project };

  const agent = Math.max(Math.min(args.agentMin, args.agentWidth), args.agentWidth - overflow);
  const left = overflow - (args.agentWidth - agent);
  if (left <= 0) return { agent, project };
  return { agent, project: Math.max(Math.min(args.projectMin, project), project - left) };
}
