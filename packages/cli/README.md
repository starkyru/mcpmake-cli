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

## Six ways in

| Input | Command |
|-------|---------|
| OpenAPI / Swagger spec | `mcpmake from openapi ./spec.yaml -o ./server` |
| Postman collection | `mcpmake from postman ./collection.json -o ./server` |
| HAR capture (recorded traffic) | `mcpmake from har ./session.har -o ./server` |
| A live URL (record it for you) | `mcpmake from url https://api.example.com -o ./server` |
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

Generated servers can be published to the MCP ecosystem — mcp.so, Smithery,
Glama, and the official registry:

```bash
mcpmake publish ./server
```

## Pricing

The CLI is free and Apache-2.0. Paid plans cover continuous spec-sync, team
features, self-hosting, and migration help. Print the current plans (fetched live
from mcpmake.dev, falling back to the copy bundled with your CLI when offline):

```bash
mcpmake pricing
```

**Prices are subject to change — see
[mcpmake.dev/#pricing](https://mcpmake.dev/#pricing) for the latest.**

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
