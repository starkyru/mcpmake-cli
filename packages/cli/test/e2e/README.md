# mcpmake E2E test suite

True end-to-end tests: they spawn the **built** `mcpmake` binary
(`packages/cli/bin/mcpmake.mjs` → `dist/`) as a real child process in a
scrubbed-env tmpdir sandbox, then assert real files, exit codes, and
stdout/stderr. This complements (does not replace) the fast in-process unit
tier, which imports commands and calls `command.run!(ctx)` directly.

## Running

```bash
npm run build                       # required first — tests run against dist/
MCPMAKE_E2E=1 npm run test:e2e      # whole suite
MCPMAKE_E2E=1 npx vitest run -c vitest.e2e.config.ts packages/cli/test/e2e/foo.e2e.test.ts   # one file
```

The whole suite is gated behind `MCPMAKE_E2E=1` (the fast tier never picks up
`*.e2e.test.ts`). Heavier tiers add flags: `MCPMAKE_E2E_HEAVY` (real
install/build/run + MCP handshake), `MCPMAKE_E2E_BROWSER` (Playwright crawls).

## Harness API (`./helpers/*`, import with the `.js` extension)

- **run-cli.js** — `runCli(args, opts?) => {stdout, stderr, code, signal}`.
  Env is scrubbed: only `PATH` is inherited; `HOME` + `MCPMAKE_CONFIG_DIR`
  default to `opts.cwd`; `CI=1` and `MCPMAKE_NO_UPSELL=1` are set; the dev
  shell's `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `MCPMAKE_DEPLOY_TOKEN` are
  never inherited. A non-zero exit does **not** reject — assert `result.code`.
  `opts.env` is merged over the base, so a test may inject `MCPMAKE_SERVER`,
  `OPENAI_BASE_URL`, `MCPMAKE_LLM_PROVIDER`, `MCPMAKE_INSECURE`,
  `MCPMAKE_ALLOW_PRIVATE_HOSTS`, a dummy `OPENAI_API_KEY`, etc.
  Also `combined(result)` (ANSI-stripped `stdout+stderr` — use for text
  assertions) and `stripAnsi(s)`.
- **sandbox.js** — `withTempDir(async (dir) => {...})`, `makeTempDir()`,
  `removeTempDir(dir)`. Always do filesystem work inside a sandbox.
- **build-guard.js** — `ensureBuilt()` (call in `beforeAll`); fails fast with a
  fix-it message if `dist/` is missing. Also `BIN_PATH`, `CLI_DIST`,
  `CORE_DIST`, `REPO_ROOT`.
- **assert-tree.js** — `listTree(dir)`, `assertTreeEquals(dir, string[])`,
  `assertTreeContains(dir, string[])`. Paths are relative, POSIX-slashed,
  sorted; `node_modules`/`.git` ignored.
- **gating.js** — `E2E`, `E2E_BROWSER`, `E2E_HEAVY` booleans.

## Conventions

- File names end `.e2e.test.ts`; live under `packages/cli/test/e2e/`.
- Wrap suites in `describe.skipIf(!E2E)(...)` and call
  `beforeAll(() => ensureBuilt())`.
- Output is non-TTY, so consola prefixes lines (`[info]`, `[error]`,
  `[success]`, `[warn]`) and wraps some tokens in backticks. Assert on
  substrings of `combined(result)`, not whole-output equality.
- Assertions must be discriminating: exact tool counts, exact filenames, exact
  exit codes, specific message substrings — never just truthiness/length.
- Helpers in `./helpers/`, fixtures in `./fixtures/`.
