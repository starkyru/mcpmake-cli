/**
 * Wraps a citty command so it honours `.mcpmake.yaml`: a `--config` flag is
 * added and config-file values are overlaid onto the parsed args (without
 * overriding explicit CLI flags) right before the command runs.
 */

import { defineCommand, type ArgsDef, type CommandDef, type CommandContext } from 'citty';
import { applyConfigToArgs, displayPath } from './mcpmake-config.js';
import { logger } from '../utils/logger.js';
import { fail } from '../utils/fail.js';

const CONFIG_ARG = {
  type: 'string' as const,
  description:
    'Path to a .mcpmake.yaml config file (default: auto-discovered in the working directory)',
};

/**
 * Drop-in replacement for `defineCommand` that layers `.mcpmake.yaml` config in.
 *
 * @param commandName Name used to look up a per-command override section.
 * @param def         The command definition (same shape as `defineCommand`).
 */
export function defineConfigurableCommand<T extends ArgsDef>(
  commandName: string,
  def: CommandDef<T>,
): CommandDef<T> {
  const originalRun = def.run;
  const baseArgs = (def.args && typeof def.args === 'object' ? def.args : {}) as ArgsDef;

  // citty enforces `required` during parsing — before our config overlay runs —
  // so a required *flag* the user supplied via .mcpmake.yaml would be rejected.
  // Relax those flags for citty and re-validate after merging config below.
  // (Required positionals stay enforced: they always belong on the command line.)
  const requiredFlags: string[] = [];
  const relaxedArgs: ArgsDef = {};
  for (const [name, d] of Object.entries(baseArgs)) {
    const ad = d as { type?: string; required?: boolean; default?: unknown };
    if (ad.required === true && ad.type !== 'positional' && ad.default === undefined) {
      requiredFlags.push(name);
      relaxedArgs[name] = { ...(d as object), required: false } as ArgsDef[string];
    } else {
      relaxedArgs[name] = d;
    }
  }
  const argsWithConfig = { ...relaxedArgs, config: CONFIG_ARG };

  return defineCommand<T>({
    ...def,
    args: argsWithConfig as unknown as T,
    async run(ctx: CommandContext<T>) {
      const args = ctx.args as Record<string, unknown>;
      try {
        const result = applyConfigToArgs(args, ctx.rawArgs, commandName, argsWithConfig, {
          configPath: typeof args.config === 'string' ? args.config : undefined,
        });
        if (result.path && result.applied.length > 0) {
          logger.info(
            `Loaded ${result.applied.length} setting(s) from ${displayPath(result.path)}: ` +
              result.applied.join(', '),
          );
        }
      } catch (err) {
        await fail(`Config error: ${err instanceof Error ? err.message : String(err)}`, err);
      }

      // Re-enforce required flags now that config has been applied.
      const missing = requiredFlags.filter((k) => {
        const v = args[k];
        return v === undefined || v === null || v === '';
      });
      if (missing.length > 0) {
        await fail(
          missing
            .map(
              (k) =>
                `Missing required argument: --${k} (set it on the command line or in .mcpmake.yaml)`,
            )
            .join('\n'),
        );
      }

      return originalRun?.(ctx);
    },
  });
}
