import { defineCommand } from 'citty';
import { resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import { generateMcpb } from '@mcpmake/core';
import { childEnv } from '../env.js';

const execFile = promisify(execFileCb);

export default defineCommand({
  meta: {
    name: 'bundle',
    description: 'Bundle a generated MCP server project into an .mcpb file',
  },
  args: {
    directory: {
      type: 'positional',
      description: 'Path to the generated MCP server project',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output path for the .mcpb file',
    },
    'skip-build': {
      type: 'boolean',
      description: 'Skip npm install and build steps (use if already built)',
      default: false,
    },
  },
  async run({ args }) {
    const projectDir = resolve(args.directory);

    const pkgPath = resolve(projectDir, 'package.json');
    if (!(await pathExists(pkgPath))) {
      await fail(`Not a valid project directory (no package.json): ${projectDir}`);
    }

    if (!args['skip-build']) {
      await buildProject(projectDir);
    }

    const outputPath = args.output ? resolve(args.output) : undefined;

    logger.info('Creating .mcpb bundle...');

    try {
      const mcpbPath = await generateMcpb({
        projectDir,
        outputPath,
      });
      logger.success(`MCPB bundle created: ${mcpbPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await fail(`Bundle failed: ${message}`, err);
    }
  },
});

/**
 * Install production dependencies and build the project.
 */
async function buildProject(projectDir: string): Promise<void> {
  logger.info('Installing production dependencies...');
  try {
    await execFile('npm', ['install', '--omit=dev'], {
      cwd: projectDir,
      timeout: 120_000,
      // Strip NODE_OPTIONS/loader vars so this spawn can't be hijacked into
      // running attacker code (defense in depth — see childEnv).
      env: childEnv(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`npm install failed: ${message}`);
  }

  logger.info('Building project...');
  try {
    await execFile('npm', ['run', 'build'], {
      cwd: projectDir,
      timeout: 120_000,
      env: childEnv(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`npm run build failed: ${message}`);
  }
}
