/**
 * `.mcpmake.yaml` project config — kills CLI-flag repetition and enables
 * team-shared, version-controlled generation settings.
 *
 * Schema: top-level keys are global defaults applied to every command; an
 * optional section keyed by a command name overrides them for that command.
 *
 *   # .mcpmake.yaml
 *   output: ./generated         # global default for all commands
 *   transport: http
 *   format: typescript
 *   openapi:                     # per-command overrides
 *     base-url: https://api.example.com
 *     include: [users, repos]    # arrays map to the comma-separated flag form
 *   deploy:
 *     url: https://mcpmake.dev
 *
 * Precedence (highest wins): explicit CLI flag > per-command section >
 * global key > the command's built-in default. Positional args (e.g. the spec
 * path) are never taken from config — they stay on the command line.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ArgsDef } from 'citty';
import { logger } from '../utils/logger.js';

/** Command names that may appear as config sections (vs. global keys). */
export const KNOWN_COMMANDS = new Set<string>([
  'openapi',
  'har',
  'url',
  'describe',
  'postman',
  'website',
  'stainless',
  'deploy',
  'verify',
  'update',
  'publish',
  'merge',
  'lint',
  'diff',
  'bundle',
  'ci',
]);

const CONFIG_FILENAMES = ['.mcpmake.yaml', '.mcpmake.yml'] as const;

export interface LoadedConfig {
  path: string;
  data: Record<string, unknown>;
}

export interface ConfigEnv {
  /** Explicit path from a `--config` flag (highest priority). */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve which config file to use, or null if none.
 *
 * Order: explicit `--config` path → `MCPMAKE_CONFIG` env → auto-discovered
 * `.mcpmake.yaml`/`.yml` in the working directory. An explicit path that does
 * not exist is an error; auto-discovery silently yields null.
 */
export function findConfigPath(deps: ConfigEnv = {}): string | null {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;

  const explicit = deps.configPath || env.MCPMAKE_CONFIG;
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(p)) {
      throw new Error(`Config file not found: ${explicit}`);
    }
    return p;
  }

  for (const name of CONFIG_FILENAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read + parse the config file, or null when there is none. Throws on malformed YAML. */
export function loadConfig(deps: ConfigEnv = {}): LoadedConfig | null {
  const path = findConfigPath(deps);
  if (!path) return null;

  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (parsed == null) return { path, data: {} };
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${path} must be a YAML mapping (key: value pairs)`);
  }
  return { path, data: parsed };
}

/** Global keys = every top-level key that is not a command section. */
export function globalConfig(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (KNOWN_COMMANDS.has(k) && isPlainObject(v)) continue;
    out[k] = v;
  }
  return out;
}

/** The per-command override section, or an empty object. */
export function sectionConfig(
  data: Record<string, unknown>,
  commandName: string,
): Record<string, unknown> {
  const section = data[commandName];
  return isPlainObject(section) ? section : {};
}

/**
 * Set of arg names explicitly present on the command line (so they win over
 * config). Scans the raw argv: `--name`, `--name=v`, and `--no-name` all mark
 * `name`; short aliases (`-o`) resolve through the arg spec. Stops at `--`.
 */
export function explicitFlags(rawArgs: string[], argSpec: ArgsDef): Set<string> {
  const aliasToName: Record<string, string> = {};
  for (const [name, def] of Object.entries(argSpec)) {
    const alias = (def as { alias?: string | string[] }).alias;
    if (!alias) continue;
    for (const a of Array.isArray(alias) ? alias : [alias]) {
      aliasToName[a] = name;
    }
  }

  const set = new Set<string>();
  for (const tok of rawArgs) {
    if (tok === '--') break;
    if (tok.startsWith('--')) {
      const raw = tok.slice(2).split('=')[0];
      if (!raw) continue;
      // `--no-force` negates a boolean `force`, but an arg may also be *named*
      // `no-resources` (a positive flag). Prefer a literal arg-name match; only
      // strip `no-` when the bare name is the real arg.
      if (!(raw in argSpec) && raw.startsWith('no-') && raw.slice(3) in argSpec) {
        set.add(raw.slice(3));
      } else {
        set.add(raw);
      }
    } else if (tok.length > 1 && tok[0] === '-' && !/^-\d/.test(tok)) {
      // Short flag(s): support bundled forms like -fw.
      for (const ch of tok.slice(1)) {
        const name = aliasToName[ch];
        if (name) set.add(name);
      }
    }
  }
  return set;
}

/** Coerce a YAML value to the type the citty arg expects. */
function coerceValue(value: unknown, type: string | undefined): unknown {
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value === 'true' || value === '1' || value === 'yes';
    }
    return Boolean(value);
  }
  if (type === 'string') {
    if (Array.isArray(value)) return value.join(',');
    return value == null ? value : String(value);
  }
  return value;
}

export interface ApplyResult {
  /** Path of the config file used, or null when none applied. */
  path: string | null;
  /** Arg names that were filled from config (not overridden by a CLI flag). */
  applied: string[];
}

/**
 * Overlay config-file values onto already-parsed citty `args`, mutating it in
 * place. CLI flags (detected via rawArgs) and positionals are never touched.
 * Returns which keys were applied so the caller can surface it.
 */
export function applyConfigToArgs(
  args: Record<string, unknown>,
  rawArgs: string[],
  commandName: string,
  argSpec: ArgsDef,
  deps: ConfigEnv = {},
): ApplyResult {
  const loaded = loadConfig(deps);
  if (!loaded) return { path: null, applied: [] };

  const global = globalConfig(loaded.data);
  const section = sectionConfig(loaded.data, commandName);

  // Warn on typos in a command-specific section (global keys may legitimately
  // target other commands, so those are not warned).
  for (const key of Object.keys(section)) {
    if (!(key in argSpec)) {
      logger.warn(`Unknown setting "${commandName}.${key}" in ${loaded.path} — ignored`);
    }
  }

  const merged = { ...global, ...section };
  const explicit = explicitFlags(rawArgs, argSpec);
  const applied: string[] = [];

  for (const [key, value] of Object.entries(merged)) {
    const def = argSpec[key] as { type?: string } | undefined;
    if (!def) continue; // unknown global key — silently skip (may target another command)
    if (def.type === 'positional') continue; // positionals stay on the CLI
    if (explicit.has(key)) continue; // explicit CLI flag wins
    args[key] = coerceValue(value, def.type);
    applied.push(key);
  }

  return { path: loaded.path, applied };
}

/** Render a config path relative to cwd for friendly logging. */
export function displayPath(path: string, cwd = process.cwd()): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}
