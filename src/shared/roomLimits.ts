// Resource limits of room lead terminals (ADR 0005, Rooms-d). Config values are
// user-editable JSON, so each read is clamped; a missing or bad value is the default.

export const ROOM_PTY_CAP_DEFAULT = 3;
export const ROOM_PTY_CAP_MAX = 10;
export const ROOM_IDLE_MINUTES_DEFAULT = 30;
/** One day. 0 turns idle shutdown off. */
export const ROOM_IDLE_MINUTES_MAX = 24 * 60;
/** Room lead terminals keep this many lines; other terminals keep the pool default. */
export const ROOM_SCROLLBACK_LINES = 10_000;

/** Live room lead terminals allowed at once: a whole number from 1 to 10, default 3. */
export function roomPtyCap(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= ROOM_PTY_CAP_MAX
    ? (value as number)
    : ROOM_PTY_CAP_DEFAULT;
}

/** Minutes a hidden, silent lead terminal may live: 0 (never stop) to one day, default 30. */
export function roomIdleMinutes(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= ROOM_IDLE_MINUTES_MAX
    ? (value as number)
    : ROOM_IDLE_MINUTES_DEFAULT;
}
