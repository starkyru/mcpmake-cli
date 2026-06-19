import { readFile, readdir, mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';
import { pathExists } from '../utils/fs.js';

const execFile = promisify(execFileCb);

export interface McpbManifest {
  schema_version: string;
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  runtime: string;
  entry_point: string;
  tools: { name: string; description: string }[];
  env_vars: { name: string; description: string; required: boolean }[];
}

/**
 * Generate an .mcpb bundle from a built MCP server project.
 *
 * The bundle is a zip file containing:
 *   manifest.json  - metadata, tool list, config schema
 *   server/        - the Node.js server code (package.json, dist/, node_modules/)
 */
export async function generateMcpb(opts: {
  projectDir: string;
  outputPath?: string;
  manifest?: Partial<McpbManifest>;
}): Promise<string> {
  const { projectDir } = opts;

  // Validate project structure
  const pkgPath = resolve(projectDir, 'package.json');
  if (!(await pathExists(pkgPath))) {
    throw new Error(`Not a valid project directory (no package.json): ${projectDir}`);
  }

  const distDir = resolve(projectDir, 'dist');
  if (!(await pathExists(distDir))) {
    throw new Error(
      `No dist/ directory found. Build the project first: cd ${projectDir} && npm run build`,
    );
  }

  // Read project metadata
  const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'));
  const projectName: string = pkgJson.name ?? 'mcp-server';
  const projectVersion: string = pkgJson.version ?? '1.0.0';
  const projectDescription: string = pkgJson.description ?? '';

  // Extract tool list (reuse same strategies as publish.ts)
  const tools = await extractToolList(projectDir);

  // Extract env vars from .env.example
  const envVars = await extractEnvVars(projectDir);

  // Build the manifest
  const manifest: McpbManifest = {
    schema_version: '1.0',
    name: opts.manifest?.name ?? projectName,
    version: opts.manifest?.version ?? projectVersion,
    description: opts.manifest?.description ?? projectDescription,
    author: opts.manifest?.author ?? '',
    license: opts.manifest?.license ?? 'proprietary',
    runtime: opts.manifest?.runtime ?? 'node',
    entry_point: opts.manifest?.entry_point ?? 'server/dist/index.js',
    tools: opts.manifest?.tools ?? tools,
    env_vars: opts.manifest?.env_vars ?? envVars,
  };

  // Create temp staging directory
  const stagingDir = await mkdtemp(join(tmpdir(), 'mcpb-'));

  try {
    // Create server/ subdirectory with the project contents
    const serverDir = join(stagingDir, 'server');

    // Copy dist/
    await cp(resolve(projectDir, 'dist'), join(serverDir, 'dist'), { recursive: true });

    // Copy package.json (stripped to essentials)
    const minimalPkg = {
      name: pkgJson.name,
      version: pkgJson.version,
      description: pkgJson.description,
      type: pkgJson.type,
      main: pkgJson.main,
      dependencies: pkgJson.dependencies,
    };
    await writeFile(join(serverDir, 'package.json'), JSON.stringify(minimalPkg, null, 2), 'utf-8');

    // Copy node_modules/ if present
    const nodeModulesDir = resolve(projectDir, 'node_modules');
    if (await pathExists(nodeModulesDir)) {
      await cp(nodeModulesDir, join(serverDir, 'node_modules'), { recursive: true });
    }

    // Write manifest.json at root of the bundle
    await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    // Determine output path
    const outputPath = opts.outputPath ?? resolve(projectDir, '..', `${basename(projectDir)}.mcpb`);

    // Create the zip archive using the system zip command
    await execFile('zip', ['-r', '-q', resolve(outputPath), '.'], {
      cwd: stagingDir,
    });

    return outputPath;
  } finally {
    // Clean up staging directory
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Extract tool names and descriptions from a generated project.
 * Tries tool-catalog.json first, then scans src/tools/*.ts files.
 */
async function extractToolList(
  projectDir: string,
): Promise<{ name: string; description: string }[]> {
  // Strategy 1: tool-catalog.json (dynamic discovery projects)
  const catalogPath = resolve(projectDir, 'src/tool-catalog.json');
  if (await pathExists(catalogPath)) {
    try {
      const catalog = JSON.parse(await readFile(catalogPath, 'utf-8'));
      if (Array.isArray(catalog)) {
        return catalog.map((entry: { name: string; description?: string; title?: string }) => ({
          name: entry.name,
          description: entry.description ?? entry.title ?? '',
        }));
      }
    } catch {
      logger.warn('Failed to parse tool-catalog.json, falling back to tool file scanning');
    }
  }

  // Strategy 2: Parse individual tool handler files in src/tools/
  const toolsDir = resolve(projectDir, 'src/tools');
  if (!(await pathExists(toolsDir))) {
    return [];
  }

  const tools: { name: string; description: string }[] = [];

  let entries: string[];
  try {
    entries = await readdir(toolsDir);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (file === 'index.ts' || !file.endsWith('.ts')) continue;

    try {
      const content = await readFile(join(toolsDir, file), 'utf-8');

      const nameMatch = content.match(/registerTool\(\s*['"]([^'"]+)['"]/);
      if (!nameMatch) continue;

      const descMatch = content.match(/description:\s*[`'"]([^`'"]*)[`'"]/);

      tools.push({
        name: nameMatch[1],
        description: descMatch ? descMatch[1] : '',
      });
    } catch {
      // skip files that can't be read
    }
  }

  return tools;
}

/**
 * Extract environment variable definitions from .env.example.
 * Each line is expected to be: VAR_NAME=value  # optional comment
 */
async function extractEnvVars(
  projectDir: string,
): Promise<{ name: string; description: string; required: boolean }[]> {
  const envPath = resolve(projectDir, '.env.example');
  if (!(await pathExists(envPath))) {
    return [];
  }

  const content = await readFile(envPath, 'utf-8');
  const vars: { name: string; description: string; required: boolean }[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const name = trimmed.slice(0, eqIndex).trim();
    if (!name) continue;

    // Extract inline comment as description
    const valuePart = trimmed.slice(eqIndex + 1);
    const commentIndex = valuePart.indexOf('#');
    const description = commentIndex >= 0 ? valuePart.slice(commentIndex + 1).trim() : '';

    vars.push({
      name,
      description,
      required: true,
    });
  }

  return vars;
}
