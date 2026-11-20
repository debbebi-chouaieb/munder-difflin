// Shared text styles of the room panel's parts.

export const heading = {
  margin: 0, fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-500)'
} as const;

export const muted = { margin: 0, fontSize: 12, color: 'var(--cth-ink-500)' } as const;

export const warning = { ...muted, color: 'var(--cth-coral)' } as const;
