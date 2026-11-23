// Agent definitions from `.claude/agents/<name>.md` (ADR 0009). Pure: main reads a
// capped head of each file and passes the text in. The files come from repos that
// may not be trusted, so anything not understood becomes null, never a guess.

import { cleanText } from './untrustedText';

/** A `.md` file in an agents folder and the first bytes of it (null when unreadable). */
export interface AgentFileHead {
  file: string;
  head: string | null;
}

export interface AgentDefinition {
  /** Name taken from the file name: the stable key. */
  file: string;
  /** Frontmatter `name` when valid, else `file`. */
  name: string;
  /** A known model alias or `claude-…` id, else null. */
  model: string | null;
  /** One clean line of at most DESCRIPTION_MAX_CHARS, or null. */
  description: string | null;
}

export const AGENT_HEAD_BYTES = 8 * 1024;
export const MAX_AGENT_FILES = 100;
const DESCRIPTION_MAX_CHARS = 200;

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable', 'inherit']);
const MODEL_ID = /^claude-[a-z0-9]+(?:[.-][a-z0-9]+){0,8}$/;
const MODEL_ID_MAX = 64;
const WANTED = ['name', 'model', 'description'] as const;
type Field = (typeof WANTED)[number];

export function isAgentName(value: string): boolean {
  return AGENT_NAME.test(value);
}

/** The agent name a file name gives, or null for a non-`.md` file or an invalid name. */
export function agentNameOfFile(file: string): string | null {
  if (!file.toLowerCase().endsWith('.md')) return null;
  const name = file.slice(0, -3);
  return isAgentName(name) ? name : null;
}

export function isKnownModel(value: string): boolean {
  return MODEL_ALIASES.has(value) || (value.length <= MODEL_ID_MAX && MODEL_ID.test(value));
}

/** One definition per valid file name, sorted by file in code-point order. */
export function agentDefinitionsFrom(files: AgentFileHead[]): AgentDefinition[] {
  const byFile = new Map<string, AgentDefinition>();
  for (const { file, head } of files) {
    const key = agentNameOfFile(file);
    if (key === null || byFile.has(key)) continue;
    const fields = head === null ? {} : parseAgentFrontmatter(head);
    byFile.set(key, {
      file: key,
      name: fields.name && isAgentName(fields.name) ? fields.name : key,
      model: fields.model && isKnownModel(fields.model) ? fields.model : null,
      description: cleanText(fields.description, DESCRIPTION_MAX_CHARS)
    });
  }
  return [...byFile.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * The `name`, `model` and `description` of a `---` fenced frontmatter block. Only
 * top-level `key: value` lines with a plain or quoted single-line value count; a
 * block scalar, a duplicate key or a block that does not close gives nothing.
 */
export function parseAgentFrontmatter(head: string): Partial<Record<Field, string>> {
  const lines = head.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return {};
  const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (close < 0) return {};
  const out: Partial<Record<Field, string>> = {};
  const seen = new Set<string>();
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!(WANTED as readonly string[]).includes(key)) continue;
    const field = key as Field;
    // A key given twice is dropped: which one Claude Code uses is not ours to guess.
    if (seen.has(field)) { delete out[field]; continue; }
    seen.add(field);
    const value = scalarValue(m[2] ?? '');
    if (value !== null) out[field] = value;
  }
  return out;
}

function scalarValue(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('|') || value.startsWith('>')) return null;
  if (value.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
    return m ? m[1].replace(/\\(["\\])/g, '$1') : null;
  }
  if (value.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
    return m ? m[1].replace(/''/g, "'") : null;
  }
  // YAML flow collections and anchors are not plain strings.
  if (/^[[{&*!]/.test(value)) return null;
  return value.replace(/\s+#.*$/, '').trim() || null;
}
