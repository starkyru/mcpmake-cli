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

## Parity tier (`parity/generated-parity.e2e.test.ts`, HEAVY)

Generates **one** OpenAPI fixture (`fixtures/parity.yaml`) as all three targets,
RUNS four runtimes — node-stdio, node-http (`TRANSPORT=http`), a Cloudflare
Worker under `wrangler dev`, and a python FastMCP server in a venv — against a
single recording mock upstream, and cross-compares real MCP traffic:

- `tools/list`: identical tool inventory; schemas deep-equal after language
  envelopes are stripped (`helpers/normalize-mcp.ts` — unit-tested in the fast
  tier by `packages/cli/test/normalize-mcp.unit.test.ts`).
- `tools/call`: identical canonical upstream wire request (method / path /
  query / `X-Api-Key` / JSON body) and identical normalized result.
- Every KNOWN divergence (control args, tool title, outputSchema provenance,
  structuredContent, annotations, upstream-error `isError`, `MCP_TOOLS`
  filtering, http transport) is pinned in `parity/asymmetries.ts` and asserted
  in **both directions** — a gap silently closing fails just like a capability
  silently regressing.

When drift is INTENTIONAL (a feature added to or removed from one target),
update the boolean table / error-text regexes in `parity/asymmetries.ts` in the
same change, with a comment saying why — the table is the documented contract
of what each target does and does not do.

Run locally (needs network for npm installs, a `python3`, and ~5 min):

```bash
npm run build
MCPMAKE_E2E=1 MCPMAKE_E2E_HEAVY=1 npx vitest run -c vitest.e2e.config.ts \
  packages/cli/test/e2e/parity/generated-parity.e2e.test.ts
```

A runtime whose toolchain can't be provisioned (offline, no python, wrangler
boot failure) skips cleanly with a `[parity] SKIP …` console line; the
remaining runtimes are still cross-compared.

## Real-world corpus (`corpus/real-world-corpus.e2e.test.ts`, HEAVY)

11 public API specs (`corpus/manifest.ts`: twilio, netlify, spotify, slack,
discord, openai, asana, plaid, docker-engine, kubernetes, stripe — 4× Swagger
2.0, 5× OAS 3.0, 2× OAS 3.1, 58–1106 operations) that the generator must
handle end-to-end. Per spec: node generation with the EXACT manifest tool inventory →
tsc compile → real MCP boot + `tools/list` → python generation with the
IDENTICAL tool inventory → python import in a venv. Deep `tools/call`
cross-comparison stays in the parity tier (controlled fixture + mock
upstream); the corpus proves the same contracts hold on real-world input.

Specs are downloaded on demand (commit-pinned URLs, sha256-verified) into
`node_modules/.cache/mcpmake-corpus/` — never vendored. Offline: downloads and
toolchains skip cleanly, hash mismatches fail loudly. When generator output
legitimately changes (naming, operation support), update the manifest's
`toolCount`/`sampleTools` in the same change, with review — those numbers are
the pinned contract.

Schema expansion is bounded (`schema-converter.ts`: node budget + per-schema
byte cap + nested-description trimming) — without it, stripe's shared-schema
web OOMs generation outright and kubernetes emits 68 MB of zod that no tsc
heap can check. A `typecheck: false` manifest flag exists to pin (not hide)
any future spec that regresses tsc-checkability; currently all entries
typecheck.

Run locally (~10–15 min, needs network + python3):

```bash
npm run build
MCPMAKE_E2E=1 MCPMAKE_E2E_HEAVY=1 npx vitest run -c vitest.e2e.config.ts \
  packages/cli/test/e2e/corpus/real-world-corpus.e2e.test.ts
```
