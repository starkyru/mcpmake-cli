# mcpmake

**Turn any API into an MCP server an AI agent can actually use — in one command.**

`mcpmake` reads what you already have — an OpenAPI spec, a Postman collection, a
HAR capture, a live URL, a whole website, or just a plain-English description —
and generates a clean, typed, editable [Model Context Protocol](https://modelcontextprotocol.io)
server. No boilerplate, no SDK lock-in.

[![npm](https://img.shields.io/npm/v/mcpmake.svg)](https://www.npmjs.com/package/mcpmake)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

---

## Ways in

**Primary paths** — deterministic, driven by a spec or recorded traffic you already have:

| Input | Command |
|-------|---------|
| OpenAPI / Swagger spec | `mcpmake from openapi ./spec.yaml -o ./server` |
| Postman collection | `mcpmake from postman ./collection.json -o ./server` |
| HAR capture (recorded traffic) | `mcpmake from har ./session.har -o ./server` |
| Stainless config (migration) | `mcpmake from stainless ./stainless.yaml -o ./server` |
| A live URL (record it for you) | `mcpmake from url https://api.example.com -o ./server` |

**Experimental paths** — browser- and LLM-driven, best-effort, and higher-variance
across arbitrary real-world sites/prompts. Review the generated server before you ship it:

| Input | Command |
|-------|---------|
| A whole website (browser tools) | `mcpmake from website https://example.com -o ./server` |
| A plain-English description | `mcpmake from describe "a todo API with auth" -o ./server` |

Every path produces the same thing: an MCP server **you own**.

## Quickstart

```bash
npx mcpmake from openapi ./spec.yaml -o ./server
```

Then point your MCP client (Claude Desktop, Cursor, your own agent, …) at the
generated server. That's it.

```bash
cd server
npm install
npm start
```

## You own the output

`mcpmake` is licensed under **Apache-2.0**, and so is the code it produces — but
your generated server has **no runtime dependency on mcpmake and no license
strings attached**. Edit it, host it, ship it, sell it. There is no lock-in: the
output is plain TypeScript (or Python, or a Cloudflare Worker) that you control.

## Don't want to host it yourself?

Generating the server is the easy part. Running it in production — with auth,
metering, rate limits, and quotas — is where the work is.

**Deploy and host your MCP server with auth, metering, and quotas at
[mcpmake.dev](https://mcpmake.dev).** Sign up, push, and get a managed endpoint:

```bash
mcpmake deploy ./server
```

## Keep it in sync (CI)

APIs drift. When your spec changes, your MCP server should regenerate itself.
Wire it into CI in one step:

```bash
mcpmake ci init
```

This scaffolds a GitHub Actions workflow that re-generates your server on every
spec change. Pair it with managed [spec-sync on mcpmake.dev](https://mcpmake.dev)
to keep a hosted server continuously up to date.

## Migrating off Stainless?

`mcpmake` reads the **same OpenAPI spec** your Stainless SDK is built from — you
are one command away from an MCP server:

```bash
mcpmake from stainless ./stainless.yml -o ./server
```

See the migration guide at **[mcpmake.dev](https://mcpmake.dev)**.

## Publish to a registry

Generate the registry manifests your server needs for the MCP ecosystem — mcp.so,
Smithery, Glama, and the official registry — and hand off to `mcp-publisher` for the
actual upload:

```bash
mcpmake publish ./server
```

> Manifest generation is tested end-to-end; live upload depends on the external
> `mcp-publisher` and each registry's API. Verify the publish against the target
> registry before relying on it in automation.

## Pricing

The CLI is free and Apache-2.0. Paid plans cover continuous spec-sync, team
features, self-hosting, and migration help. Print the current plans (fetched live
from mcpmake.dev, falling back to the copy bundled with your CLI when offline):

```bash
mcpmake pricing
```

**Prices are subject to change — see
[mcpmake.dev/#pricing](https://mcpmake.dev/#pricing) for the latest.**

## AI features & credentials

A few flags use Claude to improve the output. They are **opt-in** — without them,
`mcpmake` runs fully offline and never needs a key:

| Feature | Where | Flag |
|---------|-------|------|
| Generate a spec from plain English | `from describe` | (always) |
| Better tool names & descriptions | `from openapi` / `har` / `url` / `postman` / `stainless` | `--improve-names` |
| Semantic names for forms/buttons/links | `from website` | `--improve-names` |
| Goal-directed crawl (LLM navigation) | `from website` | `--goal "<text>"` |
| Heal broken CSS selectors | `rescan` | `--heal` (on by default) |

By default these call the **Anthropic API** with `@anthropic-ai/sdk`. The model
is auto-resolved against the live Models API (prefers `claude-sonnet-4-6`, or
`claude-haiku-4-5` for fast paths); override on any of these commands with
`--model <id>` (alias `-m`). You can also point them at **OpenAI** or any
**OpenAI-compatible** endpoint — see *Choosing a provider* below.

Provide the key in one of three ways:

```bash
# Recommended: environment variable
export ANTHROPIC_API_KEY=sk-ant-...
mcpmake from describe "a todo API with auth" -o ./server

# A .env file in the current directory is auto-loaded (real env vars win)
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
mcpmake from openapi ./spec.yaml -o ./server --improve-names

# Or pass it on the command line
mcpmake from describe "a todo API with auth" -o ./server --api-key sk-ant-...
```

> **Security:** prefer `ANTHROPIC_API_KEY` (env or `.env`). A key passed via
> `--api-key` is visible to other users in the process list (`ps`) and is
> recorded in your shell history. `--api-key` overrides the env var when both
> are set. Keep `.env` out of version control.

To route through a gateway or proxy, set `ANTHROPIC_BASE_URL` — the SDK honors
it automatically.

### Choosing a provider

Pick the LLM backend with `--provider` (or the `MCPMAKE_LLM_PROVIDER` env var).
Anthropic is the default, so existing setups need no change.

| Provider | `--provider` | Key var | Endpoint var |
|----------|--------------|---------|--------------|
| Claude (default) | `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` (optional) |
| OpenAI / ChatGPT | `openai` | `OPENAI_API_KEY` | — |
| Open-source / self-hosted | `openai-compatible` | `OPENAI_API_KEY` (often unused) | `OPENAI_BASE_URL` (required) |

```bash
# OpenAI (ChatGPT models)
export OPENAI_API_KEY=sk-...
mcpmake from openapi ./spec.yaml -o ./server --improve-names --provider openai

# Open-source via an OpenAI-compatible server (Ollama, vLLM, LM Studio, Groq, …)
export OPENAI_BASE_URL=http://localhost:11434/v1   # e.g. Ollama
mcpmake from describe "a todo API" -o ./server --provider openai-compatible -m llama3.1
```

`--model` works across all providers. For `openai`/`openai-compatible`, models
are resolved against the server's `/v1/models`; self-hosted servers that don't
list models need an explicit `--model`. Structured-output requests fall back
gracefully (native JSON schema → JSON mode → prompt-extraction) so models without
native structured output still work.

If no key is available, optional AI steps are **skipped with a warning**;
features that require a key (`from describe`, `--goal`) exit with an error.
The credentials your **generated server** needs (for the API it wraps —
`API_KEY`, `BEARER_TOKEN`, `OAUTH2_*`, …) are unrelated and live in its `.env`.

## All commands

```text
$ mcpmake --help

mcpmake — Generate MCP servers from API specifications

COMMANDS
  from openapi    Generate from an OpenAPI / Swagger spec
  from postman    Generate from a Postman collection
  from har        Generate from a HAR capture
  from url        Record a live URL and generate from the captured traffic
  from website    Crawl a website and generate browser-driven tools
  from describe   Generate from a plain-English description
  from stainless  Generate from a Stainless config (migration)
  merge           Merge multiple specs into one server
  verify          Verify a generated server against its source spec
  update          Re-generate a server from an updated spec
  diff            Show what would change before regenerating
  lint            Lint a spec for MCP-generation issues
  bundle          Bundle a server into a distributable .mcpb
  publish         Publish a server to MCP registries
  ci              Scaffold CI (spec-sync) — `mcpmake ci init`
  rescan          Re-scan a website server and heal broken selectors
  deploy          Deploy a server to managed hosting (mcpmake.dev)
  pricing         Show current plans (live from mcpmake.dev)
```

Run `mcpmake <command> --help` for command-specific flags (targets, transports,
filtering, Python / Cloudflare Workers output, and more).

## Built on `@mcpmake/core`

The CLI is a thin wrapper around
[`@mcpmake/core`](https://www.npmjs.com/package/@mcpmake/core) — the shared
generation library (parsers, transformers, emitters, templates). Use it directly
to build your own tooling.

## Requirements

- Node.js **>= 20**

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). The servers you
generate are yours.

---

Built by the [mcpmake](https://mcpmake.dev) team · [Docs](https://mcpmake.dev) · [Hosting](https://mcpmake.dev)
