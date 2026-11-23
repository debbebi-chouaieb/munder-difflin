// Coalesces one PTY's output before it crosses IPC (ADR 0005, Rooms-d). A chatty
// TUI emits hundreds of small chunks a second; each `webContents.send` costs a
// structured clone and a renderer task. Chunks are joined in order and sent at
// most every `flushMs`, or at once when `maxChars` is reached. Nothing is dropped:
// the owner flushes before it reports an exit or a kill.

export const PTY_FLUSH_MS = 16;
/** About 64 KB of UTF-16 text; output past this is sent without waiting. */
export const PTY_FLUSH_MAX_CHARS = 64 * 1024;

export interface OutputBatcherDeps {
  send: (data: string) => void;
  flushMs?: number;
  maxChars?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface OutputBatcher {
  push: (data: string) => void;
  /** Sends whatever is pending now, in order. Safe to call with nothing pending. */
  flush: () => void;
}

export function createOutputBatcher(deps: OutputBatcherDeps): OutputBatcher {
  const flushMs = deps.flushMs ?? PTY_FLUSH_MS;
  const maxChars = deps.maxChars ?? PTY_FLUSH_MAX_CHARS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let pending: string[] = [];
  let size = 0;
  let timer: unknown = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const data = pending.length === 1 ? pending[0] : pending.join('');
    pending = [];
    size = 0;
    deps.send(data);
  };

  return {
    push(data) {
      if (!data) return;
      pending.push(data);
      size += data.length;
      if (size >= maxChars) flush();
      else if (timer === null) timer = setTimer(flush, flushMs);
    },
    flush
  };
}
