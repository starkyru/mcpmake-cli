# mcpmake

**Turn any API into an MCP server an AI agent can actually use — in one command.**

`mcpmake` reads what you already have — an OpenAPI spec, a Postman collection, a
HAR capture, a Stainless config, or a live URL — and generates a clean, typed,
editable [Model Context Protocol](https://modelcontextprotocol.io) server you
**own**. No boilerplate, no SDK lock-in. (Browser- and LLM-driven paths — whole-website
capture and plain-English `describe` — also exist as **experimental**, best-effort inputs.)

[![npm](https://img.shields.io/npm/v/mcpmake.svg)](https://www.npmjs.com/package/mcpmake)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

```bash
npx mcpmake from openapi ./spec.yaml -o ./server
```

→ Full CLI docs, the six input paths, and every command live in the
**[`mcpmake` package README](./packages/cli/README.md)**.

## Packages

This repository is an npm-workspaces monorepo that publishes two packages:

- **[`mcpmake`](./packages/cli)** &nbsp;[![npm](https://img.shields.io/npm/v/mcpmake.svg)](https://www.npmjs.com/package/mcpmake) — the CLI (`npx mcpmake …`), the user-facing tool. See its **[README](./packages/cli/README.md)** for full docs.
- **[`@mcpmake/core`](./packages/core)** &nbsp;[![npm](https://img.shields.io/npm/v/@mcpmake/core.svg)](https://www.npmjs.com/package/@mcpmake/core) — the shared generation library (parsers, transformers, emitters, templates). Import it to build your own tooling.

The CLI is a thin wrapper over `@mcpmake/core`; everything that turns a spec into
a server lives in the library.

## Don't want to host it yourself?

Generating the server is the easy part — running it in production with auth,
metering, rate limits, and quotas is the work.

**Deploy and host your MCP server at [mcpmake.dev](https://mcpmake.dev)**, and
keep it continuously in sync with your API spec:

```bash
mcpmake deploy ./server
```

## You own the output

`mcpmake` is **Apache-2.0**, and so is the code it produces — but your generated
server has **no runtime dependency on mcpmake and no strings attached**. Edit it,
host it, ship it, sell it. The output is plain TypeScript (or Python, or a
Cloudflare Worker) that you control.

## Pricing

The CLI is free. Paid plans (sync, team, self-hosting, migration) are listed by
`mcpmake pricing`, fetched live from mcpmake.dev. **Prices are subject to
change — see [mcpmake.dev/#pricing](https://mcpmake.dev/#pricing) for the
latest.**

## Development

```bash
npm install        # install workspaces
npm run build      # build @mcpmake/core then mcpmake
npm test           # vitest across both packages
npm run typecheck  # type-check both packages
npm run publish:all   # build + publish core then cli (needs npm login)
```

- Node.js **>= 20**
- Versions are read from each package's `package.json` at runtime — bump the
  `version` field (root + both packages) for a release; nothing else to edit.

## License

[Apache-2.0](./LICENSE). The servers you generate are yours.

---

Built by the [mcpmake](https://mcpmake.dev) team · [Docs](https://mcpmake.dev) · [Hosting](https://mcpmake.dev)
