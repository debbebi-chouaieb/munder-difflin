// The spawn recipe (ADR 0020): the command line a provider's agent starts with,
// built from the provider preset, a model and the user's config. The renderer
// builds spawn commands with it, and main checks every renderer spawn against it,
// so both sides must use this one copy.

import { AGENT_PROVIDER_PRESETS, inferAgentProvider, providerPreset, type AgentProvider } from './agentProvider';
import { tokenizeCommand } from './commandLine';

export interface SpawnRecipeConfig {
  defaultCommand: string;
  autoMode: boolean;
}

/** Build the command line to feed into spawnPty, honoring the provider's flags,
 *  autoMode, and an optional per-agent model override. Claude keeps the user's
 *  configured `defaultCommand`; other providers use their preset binary so the
 *  app works without Claude installed. */
export function buildSpawnCommand(
  config: SpawnRecipeConfig,
  model?: string,
  provider: AgentProvider = inferAgentProvider(config.defaultCommand)
): string {
  const preset = providerPreset(provider);
  // Claude keeps the user's configured defaultCommand; custom falls back to it
  // too; every other provider (codex, grok, kimi, agy) uses its preset binary so the app
  // works even without Claude installed.
  const base =
    provider === 'claude'
      ? config.defaultCommand || preset.defaultCommand
      : provider === 'custom'
        ? config.defaultCommand || ''
        : preset.defaultCommand;
  let cmd = base;
  if (preset.supportsModel && model && preset.modelFlag) {
    // Quote model values that contain whitespace (agy labels like
    // "Gemini 3.1 Pro (High)") so the command tokenizer keeps them one arg.
    const m = /\s/.test(model) ? `"${model}"` : model;
    cmd = `${cmd} ${preset.modelFlag} ${m}`;
  }
  // Auto (skip-permissions) mode appends each provider's own flag — Claude's
  // bypassPermissions, Codex's dangerous bypass, Grok's always-approve, Kimi's
  // auto, or agy's skip flag.
  if (config.autoMode && preset.autoFlag) cmd = `${cmd} ${preset.autoFlag}`;
  return cmd;
}

// What a model id or label looks like across the presets (`claude-opus-4-8[1m]`,
// `openai/gpt-5`, `pi:high`, `Gemini 3.1 Pro (High)`). Quotes, `&|<>^%!` and
// control characters are refused: on Windows a CLI may start through cmd.exe.
const MODEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()[\]-]*$/;

const startsWith = (argv: string[], at: number, part: string[]): boolean =>
  part.length > 0 && part.every((token, i) => argv[at + i] === token);

/**
 * Whether `argv` (the binary, then its args) is what buildSpawnCommand gives for
 * this provider: the base command, then optionally the model flag and one value,
 * then the auto flag only when autoMode is on. A model value starts with a
 * letter or digit, so a flag cannot ride in as the model.
 */
export function isOnRecipe(config: SpawnRecipeConfig, provider: AgentProvider, argv: string[]): boolean {
  const preset = providerPreset(provider);
  const base = tokenizeCommand(buildSpawnCommand({ ...config, autoMode: false }, undefined, provider));
  if (!startsWith(argv, 0, base)) return false;
  let at = base.length;
  if (preset.supportsModel && preset.modelFlag && argv[at] === preset.modelFlag) {
    const value = argv[at + 1];
    if (value === undefined || !MODEL_VALUE.test(value)) return false;
    at += 2;
  }
  if (config.autoMode && preset.autoFlag) {
    const auto = tokenizeCommand(preset.autoFlag);
    if (startsWith(argv, at, auto)) at += auto.length;
  }
  return at === argv.length;
}

const SKIP_WORDS = /dangerous|yolo|bypasspermissions|skip-permissions|approve-all|always-approve/i;

/** The args that turn off a CLI's permission prompts: any preset's auto flag, or a flag named like one. */
export function permissionSkipArgs(args: string[]): string[] {
  const found = new Set<string>();
  for (const preset of AGENT_PROVIDER_PRESETS) {
    const auto = preset.autoFlag ? tokenizeCommand(preset.autoFlag) : [];
    for (let at = 0; at < args.length; at++) {
      if (startsWith(args, at, auto)) auto.forEach((_, i) => found.add(args[at + i]));
    }
  }
  for (const arg of args) if (SKIP_WORDS.test(arg)) found.add(arg);
  return args.filter((arg) => found.has(arg));
}

/** A command the user confirmed in main's dialog: started again without asking. */
export interface ApprovedSpawn {
  provider: AgentProvider;
  argv: string[];
}

export function isApprovedSpawn(v: unknown): v is ApprovedSpawn {
  if (!v || typeof v !== 'object') return false;
  const { provider, argv } = v as Record<string, unknown>;
  return typeof provider === 'string' && Array.isArray(argv) && argv.length > 0 && argv.every((s) => typeof s === 'string');
}

export function sameSpawn(a: ApprovedSpawn, b: ApprovedSpawn): boolean {
  return a.provider === b.provider && a.argv.length === b.argv.length && a.argv.every((s, i) => s === b.argv[i]);
}
