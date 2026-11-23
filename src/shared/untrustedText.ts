// Text that comes from transcripts, the ZetaHub cache or repo files is untrusted
// (ADR 0005). Before it reaches the renderer it is made one line, stripped of
// control and bidirectional-override characters, and cut to a length.

// C0/C1 controls, plus the bidi marks, embeddings, overrides and isolates that can
// reorder what a right-to-left layout shows. Written as escapes so review can see them.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One clean line of at most `maxChars`, or null when nothing is left. */
export function cleanText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const oneLine = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  if (oneLine.length <= maxChars) return oneLine;
  let cut = Math.max(0, maxChars - 1);
  // Never end on the first half of a surrogate pair: a lone half renders as junk.
  if (cut > 0 && isHighSurrogate(oneLine.charCodeAt(cut - 1))) cut--;
  return `${oneLine.slice(0, cut)}…`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
