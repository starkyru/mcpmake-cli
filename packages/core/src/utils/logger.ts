import { consola } from 'consola';

const tagged = consola.withTag('mcpmake');
// Make THIS wrapper the single gate. Consola applies its own numeric `level`
// (default 3, which hides debug); raising it so consola never filters means our
// `minLevel` check below is the only thing that decides what reaches the sink.
tagged.level = 999; // consola's "verbose" sentinel — emit everything passed in.

/**
 * Ordered severity scale. Lower number = more verbose. A message is emitted only
 * when its own severity is >= the configured minimum level.
 *
 *   debug < info = success = log < warn < error
 *
 * `success` and `log` share the `info` threshold (they are informational), so the
 * default level of `info` preserves the previously visible behaviour: info /
 * success / log / warn / error all emit, while debug stays hidden (which also
 * matched consola's own default level of 3).
 */
export const LOG_LEVELS = {
  debug: 10,
  info: 20,
  success: 20,
  log: 20,
  warn: 30,
  error: 40,
} as const;

export type LogLevelName = keyof typeof LOG_LEVELS;

/** Names that are valid as a *threshold* (one severity per distinct number). */
const THRESHOLD_NAMES: Record<string, number> = {
  debug: LOG_LEVELS.debug,
  info: LOG_LEVELS.info,
  success: LOG_LEVELS.success,
  log: LOG_LEVELS.log,
  warn: LOG_LEVELS.warn,
  error: LOG_LEVELS.error,
};

const DEFAULT_LEVEL = LOG_LEVELS.info;

function resolveEnvLevel(): number {
  // MCPMAKE_LOG_LEVEL takes precedence over the generic LOG_LEVEL.
  const raw = (process.env.MCPMAKE_LOG_LEVEL ?? process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  if (!raw) return DEFAULT_LEVEL;
  if (raw in THRESHOLD_NAMES) return THRESHOLD_NAMES[raw];
  return DEFAULT_LEVEL;
}

let minLevel = resolveEnvLevel();

type LogMethod = (...args: unknown[]) => void;

/**
 * Each method records the call (so test spies via `vi.spyOn(logger, 'info')`
 * always observe the invocation) and forwards to the underlying consola sink
 * only when the message's severity is at or above the configured minimum.
 */
function gated(name: LogLevelName, severity: number): LogMethod {
  const sink = tagged[name].bind(tagged) as LogMethod;
  return (...args: unknown[]) => {
    if (severity < minLevel) return;
    sink(...args);
  };
}

export interface Logger {
  debug: LogMethod;
  info: LogMethod;
  success: LogMethod;
  log: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  /** Current minimum severity threshold (numeric). */
  readonly level: number;
  /**
   * Set the minimum level by name (`debug` | `info` | `success` | `log` |
   * `warn` | `error`). Unknown names are ignored. Returns the resulting level.
   */
  setLevel(name: LogLevelName | string): number;
}

export const logger: Logger = {
  debug: gated('debug', LOG_LEVELS.debug),
  info: gated('info', LOG_LEVELS.info),
  success: gated('success', LOG_LEVELS.success),
  log: gated('log', LOG_LEVELS.log),
  warn: gated('warn', LOG_LEVELS.warn),
  error: gated('error', LOG_LEVELS.error),
  get level() {
    return minLevel;
  },
  setLevel(name: LogLevelName | string): number {
    const key = String(name).trim().toLowerCase();
    if (key in THRESHOLD_NAMES) {
      minLevel = THRESHOLD_NAMES[key];
    }
    return minLevel;
  },
};
