import { defineCommand } from 'citty';
import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';

const SOURCES = new Set(['openapi', 'har', 'postman']);
const TRANSPORTS = new Set(['stdio', 'http']);

export interface WorkflowOptions {
  /** Path to the spec, relative to the repo root (e.g. `api-spec.yaml`). */
  spec: string;
  /** Generated server directory (e.g. `./mcp-server`). */
  output: string;
  /** Source adapter. */
  source: 'openapi' | 'har' | 'postman';
  /** Optional server name. */
  name?: string;
  /** Transport mode for the generated server. */
  transport: 'stdio' | 'http';
  /** mcpmake version/tag to run in CI (e.g. `latest`, `0.1.0`). */
  version: string;
  /**
   * When true, on a detected drift open a pull request with the regenerated server (via
   * peter-evans/create-pull-request) instead of failing the job. This is the self-hosted
   * "maintenance PR" delivery path (the cloud offers the same via its GitHub App).
   */
  openPr?: boolean;
  /** Branch the PR is pushed to (default `mcpmake/regenerate`). Only used when `openPr`. */
  prBranch?: string;
}

const DEFAULT_PR_BRANCH = 'mcpmake/regenerate';

/** Relative file paths (spec, output dir). */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
/** Server name and npm version/tag. */
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * Path-traversal guard for SAFE_PATH-typed values (spec path, output dir).
 *
 * SAFE_PATH allows `.` and `/`, so `..` segments and leading-`/` absolute paths
 * slip past it. This rejects a value that is absolute (leading `/`) or contains
 * any `..` path segment, forcing a plain relative path. A filename that merely
 * contains two dots (e.g. `my..spec.yaml`) is fine — only an exact `..` segment
 * (split on `/`) is rejected.
 */
function isUnsafePath(value: string): boolean {
  if (value.startsWith('/')) return true;
  return value.split('/').some((segment) => segment === '..');
}

/**
 * Reject values that could break out of the generated shell `run:` step or YAML.
 * These are operator-supplied (spec path, output dir, server name, version) and
 * flow into a CI shell command; restricting them to filename/identifier
 * characters removes every command-substitution / expansion vector. For the
 * path-typed values (SAFE_PATH) we additionally reject traversal (`..`) and
 * absolute paths so the value cannot escape the repo root.
 */
function assertCiSafe(value: string, label: string, pattern: RegExp): void {
  // A leading `-` makes the value look like a CLI flag once it reaches a shell/git
  // context (e.g. `git status --porcelain "--all"` — git parses it as an option, not
  // a pathspec — so the drift gate fails OPEN). Reject it for every interpolated value.
  if (
    !pattern.test(value) ||
    value.startsWith('-') ||
    (pattern === SAFE_PATH && isUnsafePath(value))
  ) {
    throw new Error(
      `Unsafe ${label} for the CI workflow: "${value}". ` +
        `Must not start with "-"; only letters, digits and ${pattern === SAFE_PATH ? '. _ / -' : '. _ -'} are allowed.`,
    );
  }
}

/**
 * Quote a value for a double-quoted shell string. Escapes backslash first, then
 * the characters that remain special inside double quotes (`$`, backtick, `"`).
 * Combined with assertCiSafe this is defense-in-depth against command injection.
 *
 * NOTE: in a YAML *plain* scalar (`run: <cmd>` on one line) the backslash escapes pass through
 * literally, so q()'s shell-escaping is only fully effective inside a `run: |` block scalar. The
 * SAFE_PATH / SAFE_TOKEN allowlists — which already exclude `$`, backtick, `"`, spaces, `;` — are
 * the PRIMARY injection guard for every interpolated value; q() is a second layer.
 */
function q(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Build the `.github/workflows/mcpmake.yaml` contents. Pure + testable.
 *
 * The workflow regenerates the MCP server from the spec on every change and
 * fails if the committed output is stale — the "keep generated code in sync
 * with the spec" guarantee (the Stainless-style auto-regenerate-on-spec-change
 * workflow). It also runs `mcpmake verify` for OpenAPI specs.
 */
export function buildWorkflowYaml(opts: WorkflowOptions): string {
  // Validate `source` INSIDE the builder, not only in the CLI wrapper: this function is
  // exported, so a direct/programmatic caller must not be able to inject arbitrary text
  // into the generated `from <source>` run-step. `source` is an enum, so an exact-set
  // check is both the validation and the injection guard.
  if (!SOURCES.has(opts.source)) {
    throw new Error(
      `Unsafe source for the CI workflow: "${opts.source}". Use one of: openapi, har, postman.`,
    );
  }
  assertCiSafe(opts.spec, 'spec path', SAFE_PATH);
  assertCiSafe(opts.output, 'output directory', SAFE_PATH);
  assertCiSafe(opts.version, 'mcpmake version', SAFE_TOKEN);
  if (opts.name !== undefined) assertCiSafe(opts.name, 'server name', SAFE_TOKEN);
  const prBranch = opts.prBranch ?? DEFAULT_PR_BRANCH;
  // A branch name flows into the workflow YAML and a `git`/action input; restrict it to the
  // same safe-path charset (no traversal, no leading `/`) and reject a leading `-` so it can
  // never be read as a flag.
  if (opts.openPr) {
    assertCiSafe(prBranch, 'PR branch', SAFE_PATH);
    if (prBranch.startsWith('-')) {
      throw new Error(
        `Unsafe PR branch for the CI workflow: "${prBranch}". Must not start with -.`,
      );
    }
  }

  const runner = `npx --yes mcpmake@${opts.version}`;
  const genFlags = [
    `-o ${q(opts.output)}`,
    opts.name ? `-n ${q(opts.name)}` : '',
    opts.transport === 'http' ? '-t http' : '',
    '-f',
  ]
    .filter(Boolean)
    .join(' ');
  const generate = `${runner} from ${opts.source} ${q(opts.spec)} ${genFlags}`;
  const verify = `${runner} verify ${q(opts.spec)} -p ${q(opts.output)}`;

  const headerComment = opts.openPr
    ? [
        '# Generated by `mcpmake ci init --pr`.',
        '# Regenerates the MCP server from the spec on every change and, when the committed',
        '# output drifts, opens a pull request with the regenerated server (a "maintenance PR").',
      ]
    : [
        '# Generated by `mcpmake ci init`.',
        '# Regenerates the MCP server from the spec on every change and fails if the',
        '# committed output is out of date — keep your generated server in sync with',
        '# the API spec. Re-run `mcpmake from ...` locally and commit when this fails.',
      ];

  const lines: string[] = [
    ...headerComment,
    'name: mcpmake',
    '',
    'on:',
    '  push:',
    '    paths:',
    `      - ${q(opts.spec)}`,
    "      - '.github/workflows/mcpmake.yaml'",
    '  pull_request:',
    '    paths:',
    `      - ${q(opts.spec)}`,
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  sync:',
    '    runs-on: ubuntu-latest',
  ];

  // Opening a PR needs write scopes on the job's GITHUB_TOKEN; the drift-gate (fail) mode is
  // read-only and gets no extra permissions.
  if (opts.openPr) {
    lines.push('    permissions:', '      contents: write', '      pull-requests: write');
  }

  lines.push(
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '20'",
    '      - name: Regenerate MCP server from spec',
    `        run: ${generate}`,
  );

  // `mcpmake verify` currently supports OpenAPI specs only.
  if (opts.source === 'openapi') {
    lines.push('      - name: Verify generated server matches the spec', `        run: ${verify}`);
  }

  if (opts.openPr) {
    // On drift, open/update a PR with just the regenerated server dir. peter-evans/create-pull-
    // request is a no-op when the working tree is clean, so a no-change run opens nothing.
    lines.push(
      '      - name: Open a maintenance PR if the generated server changed',
      '        uses: peter-evans/create-pull-request@v6',
      '        with:',
      "          commit-message: 'chore: regenerate MCP server from spec'",
      // prBranch goes raw into a single-quoted YAML scalar (no q()): the ONLY breakout char is a
      // single-quote, which SAFE_PATH (validated above) does not permit. Do not widen SAFE_PATH
      // to allow `'` without switching this to a double-quoted + q()-escaped scalar.
      `          branch: '${prBranch}'`,
      "          title: 'Regenerate MCP server from updated spec'",
      `          add-paths: ${q(opts.output)}`,
      '          body: |',
      '            Automated by `mcpmake ci init --pr`.',
      '',
      `            The spec (${opts.spec}) changed; this PR updates the generated server`,
      `            under ${opts.output}. Review and merge to keep the server in sync.`,
      '',
    );
  } else {
    lines.push(
      '      - name: Fail if the generated server is out of date',
      '        run: |',
      `          if [ -n "$(git status --porcelain -- ${q(opts.output)})" ]; then`,
      `            echo "::error::The committed MCP server under ${opts.output} is out of date with ${opts.spec}. Regenerate it and commit the result."`,
      `            git --no-pager diff -- ${q(opts.output)}`,
      '            exit 1',
      '          fi',
      '',
    );
  }

  return lines.join('\n');
}

const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Generate a GitHub Actions workflow that regenerates + verifies the MCP server when the spec changes',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to the API spec, relative to the repo root (e.g. api-spec.yaml)',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Generated server directory',
      default: './mcp-server',
    },
    source: {
      type: 'string',
      alias: 's',
      description: 'Source adapter: openapi | har | postman',
      default: 'openapi',
    },
    name: {
      type: 'string',
      alias: 'n',
      description: 'Server name passed to generation',
    },
    transport: {
      type: 'string',
      alias: 't',
      description: 'Transport for the generated server: stdio | http',
      default: 'stdio',
    },
    'mcpmake-version': {
      type: 'string',
      description: 'mcpmake version/tag to run in CI (e.g. latest, 0.1.0)',
      default: 'latest',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite an existing workflow file',
      default: false,
    },
    pr: {
      type: 'boolean',
      description: 'On drift, open a maintenance pull request instead of failing the job',
      default: false,
    },
    'pr-branch': {
      type: 'string',
      description: 'Branch the maintenance PR is pushed to',
      default: DEFAULT_PR_BRANCH,
    },
  },
  async run({ args }) {
    const source = String(args.source);
    const transport = String(args.transport);
    if (!SOURCES.has(source)) {
      await fail(`Invalid --source "${source}". Use one of: openapi, har, postman.`);
    }
    if (!TRANSPORTS.has(transport)) {
      await fail(`Invalid --transport "${transport}". Use one of: stdio, http.`);
    }

    // Reject shell/YAML-unsafe values up front with a friendly message (the same
    // checks are enforced inside buildWorkflowYaml as a hard safety net).
    const version = String(args['mcpmake-version']);
    const output = String(args.output);
    // A leading `-` is rejected everywhere (it would be read as a flag in the generated
    // shell/git steps); the hard gate lives in buildWorkflowYaml, these give a friendly message.
    if (!SAFE_PATH.test(args.spec) || isUnsafePath(args.spec) || args.spec.startsWith('-')) {
      await fail(
        `Unsafe spec path "${args.spec}". Use a plain relative path (letters, digits, . _ / -), not starting with "-".`,
      );
    }
    if (!SAFE_PATH.test(output) || isUnsafePath(output) || output.startsWith('-')) {
      await fail(
        `Unsafe --output "${output}". Use a plain relative path (letters, digits, . _ / -), not starting with "-".`,
      );
    }
    if (
      args.name !== undefined &&
      (!SAFE_TOKEN.test(String(args.name)) || String(args.name).startsWith('-'))
    ) {
      await fail(
        `Unsafe --name "${args.name}". Use letters, digits, . _ - only, not starting with "-".`,
      );
    }
    if (!SAFE_TOKEN.test(version) || version.startsWith('-')) {
      await fail(
        `Unsafe --mcpmake-version "${version}". Use letters, digits, . _ - only, not starting with "-".`,
      );
    }
    const openPr = Boolean(args.pr);
    const prBranch = String(args['pr-branch']);
    if (
      openPr &&
      (!SAFE_PATH.test(prBranch) || isUnsafePath(prBranch) || prBranch.startsWith('-'))
    ) {
      await fail(
        `Unsafe --pr-branch "${prBranch}". Use a plain branch name (letters, digits, . _ / -).`,
      );
    }

    const workflowPath = resolve('.github/workflows/mcpmake.yaml');
    const exists = await access(workflowPath).then(
      () => true,
      () => false,
    );
    if (exists && !args.force) {
      await fail(`${workflowPath} already exists. Re-run with --force to overwrite.`);
    }

    const yaml = buildWorkflowYaml({
      spec: args.spec,
      output: String(args.output),
      source: source as WorkflowOptions['source'],
      name: args.name ? String(args.name) : undefined,
      transport: transport as WorkflowOptions['transport'],
      version: String(args['mcpmake-version']),
      openPr,
      prBranch,
    });

    await mkdir(dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, yaml, 'utf-8');

    logger.success(`Wrote ${workflowPath}`);
    logger.info('Commit it, and CI will keep the generated server in sync with the spec.');
  },
});

export default defineCommand({
  meta: {
    name: 'ci',
    description: 'CI integration helpers (GitHub Actions)',
  },
  subCommands: {
    init: initCommand,
  },
});
