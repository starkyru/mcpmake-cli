import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { buildMcpbManifest, MCPB_MANIFEST_VERSION } from '../../src/emitter/mcpb-bundler.js';

/**
 * The .mcpb manifest must validate against the OFFICIAL MCPB manifest schema (vendored from
 * anthropics/mcpb `schemas/mcpb-manifest-latest.schema.json`) — NOT a hand-rolled field list —
 * so a bundle Claude Desktop / the MCPB loader will actually accept. Validating with ajv against
 * the real schema is what makes "schema-verify the bundle" meaningful.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/mcpb-manifest.schema.json'), 'utf-8'),
);

describe('MCPB manifest conformance', () => {
  // strict:false tolerates draft-07 quirks; validateFormats:false skips format keywords
  // (email/uri) we don't need to check here (structural conformance is the point).
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(schema);

  it('buildMcpbManifest output validates against the official MCPB manifest schema', () => {
    const manifest = buildMcpbManifest({
      name: 'petstore',
      version: '1.2.3',
      description: 'Petstore MCP server',
      license: 'MIT',
      tools: [{ name: 'list_pets', description: 'List the pets' }],
      envVars: [
        { name: 'BASE_URL', description: 'API base URL', required: true },
        { name: 'API_KEY', description: 'API key', required: false },
      ],
    });
    const ok = validate(manifest);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('still conforms with no tools and no env vars (minimal project)', () => {
    const manifest = buildMcpbManifest({
      name: 'minimal',
      version: '0.0.1',
      description: '', // empty pkg description is allowed; the builder fills a default
      tools: [],
      envVars: [],
    });
    expect(validate(manifest), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('pins manifest_version to the schema const (bumps surface here on a spec update)', () => {
    // The schema fixes manifest_version with a `const`; our pinned constant must equal it, so a
    // future MCPB spec bump (new schema const) fails this test until MCPB_MANIFEST_VERSION is bumped.
    expect(schema.properties.manifest_version.const).toBe(MCPB_MANIFEST_VERSION);
  });

  it('maps env vars to user_config (sensitive for secrets) and wires server.mcp_config.env', () => {
    const m = buildMcpbManifest({
      name: 'x',
      version: '1.0.0',
      description: 'x',
      tools: [],
      envVars: [
        { name: 'API_KEY', description: 'secret', required: true },
        { name: 'BASE_URL', description: 'url', required: false },
      ],
    });
    expect(m.user_config?.api_key).toMatchObject({
      type: 'string',
      title: 'API_KEY',
      required: true,
      sensitive: true,
    });
    expect(m.user_config?.base_url).toMatchObject({ sensitive: false });
    // The server reads each configured value from user_config at launch.
    expect(m.server.mcp_config.env?.API_KEY).toBe('${user_config.api_key}');
  });

  it('emits an object author with a name (schema requires author.name)', () => {
    const m = buildMcpbManifest({
      name: 'srv',
      version: '1.0.0',
      description: 'd',
      tools: [],
      envVars: [],
    });
    expect(m.author).toEqual({ name: 'srv' }); // falls back to the project name
    const m2 = buildMcpbManifest({
      name: 'srv',
      version: '1.0.0',
      description: 'd',
      author: 'Jane Dev',
      tools: [],
      envVars: [],
    });
    expect(m2.author).toEqual({ name: 'Jane Dev' });
  });
});
