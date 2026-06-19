import { describe, it, expect } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import {
  parseStainlessConfig,
  resolveSpecPath,
  type StainlessConfig,
} from '../../src/transformer/stainless-config.js';
import {
  translateStainless,
  toolNameFromTree,
  singularize,
} from '../../src/transformer/stainless-translator.js';

/** A fresh spec per test — translateStainless mutates the document in place. */
function makeApi(): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: { title: 'Acme API', version: '1.0.0' },
    servers: [{ url: 'https://api.acme.com/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/accounts': {
        post: {
          operationId: 'createAccount',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { data: { type: 'object' } } },
                },
              },
            },
          },
        },
        get: { operationId: 'listAccounts', responses: { '200': { description: 'ok' } } },
      },
      '/accounts/{id}': {
        get: { operationId: 'getAccount', responses: { '200': { description: 'ok' } } },
        post: { operationId: 'updateAccount', responses: { '200': { description: 'ok' } } },
        delete: { operationId: 'deleteAccount', responses: { '204': { description: 'gone' } } },
      },
      '/cards': {
        post: { operationId: 'createCard', responses: { '200': { description: 'ok' } } },
      },
      '/cards/issuing': {
        post: { operationId: 'createIssuingCard', responses: { '200': { description: 'ok' } } },
      },
    },
  } as unknown as OpenAPIV3.Document;
}

const baseConfig: StainlessConfig = {
  resources: {
    accounts: {
      methods: {
        create: 'post /accounts',
        list: 'get /accounts',
        retrieve: 'get /accounts/{id}',
        update: 'post /accounts/{id}',
        del: 'delete /accounts/{id}',
      },
    },
    cards: {
      methods: { create: 'post /cards' },
      subresources: {
        issuing: { methods: { create: 'post /cards/issuing' } },
      },
    },
  },
};

function opOf(api: OpenAPIV3.Document, path: string, method: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (api.paths as any)[path][method];
}

describe('translateStainless — resource-tree naming', () => {
  it('derives Stainless-style tool names onto operations', () => {
    const api = makeApi();
    const t = translateStainless(baseConfig, api);

    expect(opOf(api, '/accounts', 'post')['x-mcp-name']).toBe('create_account');
    expect(opOf(api, '/accounts', 'get')['x-mcp-name']).toBe('list_account');
    expect(opOf(api, '/accounts/{id}', 'get')['x-mcp-name']).toBe('retrieve_account');
    expect(opOf(api, '/accounts/{id}', 'post')['x-mcp-name']).toBe('update_account');
    // `del` normalizes to delete
    expect(opOf(api, '/accounts/{id}', 'delete')['x-mcp-name']).toBe('delete_account');
    expect(opOf(api, '/cards', 'post')['x-mcp-name']).toBe('create_card');
    // nested subresource, child-first
    expect(opOf(api, '/cards/issuing', 'post')['x-mcp-name']).toBe('create_issuing_card');

    expect(t.toolNames['POST /accounts']).toBe('create_account');
    expect(t.warnings).toHaveLength(0);
  });

  it('warns when a resource method does not match any operation', () => {
    const api = makeApi();
    const cfg: StainlessConfig = {
      resources: { ghosts: { methods: { create: 'post /ghosts' } } },
    };
    const t = translateStainless(cfg, api);
    expect(t.warnings.join('\n')).toMatch(/ghosts\.create/);
  });

  it('resolves a method by operationId pointer', () => {
    const api = makeApi();
    const cfg: StainlessConfig = {
      resources: { accounts: { methods: { create: { operationId: 'createAccount' } } } },
    };
    translateStainless(cfg, api);
    expect(opOf(api, '/accounts', 'post')['x-mcp-name']).toBe('create_account');
  });
});

describe('translateStainless — x-stainless-* fallback', () => {
  it('names from operation extensions when no resource tree is present', () => {
    const api = makeApi();
    opOf(api, '/accounts', 'post')['x-stainless-resource'] = 'accounts';
    opOf(api, '/accounts', 'post')['x-stainless-method-name'] = 'create';
    const t = translateStainless({}, api);
    expect(opOf(api, '/accounts', 'post')['x-mcp-name']).toBe('create_account');
    expect(t.toolNames['POST /accounts']).toBe('create_account');
  });

  it('honours dotted x-stainless-resource for nested naming', () => {
    const api = makeApi();
    opOf(api, '/cards/issuing', 'post')['x-stainless-resource'] = 'cards.issuing';
    opOf(api, '/cards/issuing', 'post')['x-stainless-method-name'] = 'create';
    translateStainless({}, api);
    expect(opOf(api, '/cards/issuing', 'post')['x-mcp-name']).toBe('create_issuing_card');
  });
});

describe('translateStainless — skips', () => {
  it('drops a method flagged mcp:false via x-mcp-emit', () => {
    const api = makeApi();
    const cfg: StainlessConfig = {
      resources: { accounts: { methods: { create: { endpoint: 'post /accounts', mcp: false } } } },
    };
    const t = translateStainless(cfg, api);
    expect(opOf(api, '/accounts', 'post')['x-mcp-emit']).toBe('skip');
    expect(t.skipped).toContain('POST /accounts');
  });

  it('drops an operation flagged x-stainless-skip', () => {
    const api = makeApi();
    opOf(api, '/cards', 'post')['x-stainless-skip'] = true;
    const t = translateStainless({}, api);
    expect(opOf(api, '/cards', 'post')['x-mcp-emit']).toBe('skip');
    expect(t.skipped).toContain('POST /cards');
  });
});

describe('translateStainless — unwrap_response', () => {
  it('unwraps `data` when unwrap_response is true and a data envelope exists', () => {
    const api = makeApi();
    const t = translateStainless({ ...baseConfig, settings: { unwrap_response: true } }, api);
    expect(opOf(api, '/accounts', 'post')['x-mcp-jq-filter']).toBe('.data');
    // listAccounts has no `data` property → left untouched
    expect(opOf(api, '/accounts', 'get')['x-mcp-jq-filter']).toBeUndefined();
    expect(t.unwrapped).toContain('POST /accounts');
  });

  it('uses an explicit unwrap property name on every operation', () => {
    const api = makeApi();
    translateStainless({ settings: { unwrap_response: 'result' } }, api);
    expect(opOf(api, '/accounts', 'get')['x-mcp-jq-filter']).toBe('.result');
  });
});

describe('translateStainless — environments', () => {
  it('selects production and exposes the map + base URL', () => {
    const api = makeApi();
    const t = translateStainless(
      {
        environments: {
          sandbox: 'https://sandbox.acme.com/v1',
          production: 'https://api.acme.com/v1',
        },
      },
      api,
    );
    expect(t.defaultEnvironment).toBe('production');
    expect(t.baseUrl).toBe('https://api.acme.com/v1');
    expect(t.environments).toEqual({
      sandbox: 'https://sandbox.acme.com/v1',
      production: 'https://api.acme.com/v1',
    });
  });

  it('falls back to the first environment when there is no production', () => {
    const api = makeApi();
    const t = translateStainless({ environments: { staging: 'https://staging.acme.com' } }, api);
    expect(t.defaultEnvironment).toBe('staging');
  });
});

describe('translateStainless — auth override', () => {
  it('extracts security_scheme + read_env from client_settings.opts', () => {
    const api = makeApi();
    const t = translateStainless(
      {
        client_settings: {
          opts: {
            api_key: {
              type: 'string',
              read_env: 'ACME_API_KEY',
              auth: { security_scheme: 'bearerAuth' },
            },
          },
        },
      },
      api,
    );
    expect(t.authOverride).toEqual({ schemeName: 'bearerAuth', envVarName: 'ACME_API_KEY' });
  });
});

describe('translateStainless — code mode', () => {
  it('detects code-mode and warns', () => {
    const api = makeApi();
    const t = translateStainless({ mcp_server: { code: true, docs_search: true } }, api);
    expect(t.codeMode).toBe(true);
    expect(t.docsSearch).toBe(true);
    expect(t.warnings.join('\n')).toMatch(/code-mode/i);
  });

  it('detects code-mode under targets.mcp_server', () => {
    const api = makeApi();
    const t = translateStainless({ targets: { mcp_server: { tools: 'code' } } }, api);
    expect(t.codeMode).toBe(true);
  });

  it('is not code-mode for a plain per-endpoint config', () => {
    const api = makeApi();
    const t = translateStainless(baseConfig, api);
    expect(t.codeMode).toBe(false);
  });
});

describe('translateStainless — collision-safe naming', () => {
  it('disambiguates names that singularize to the same value', () => {
    const api = {
      openapi: '3.0.0',
      info: { title: 'x', version: '1.0.0' },
      servers: [{ url: 'https://x' }],
      paths: {
        '/things': {
          get: { operationId: 'listThings', responses: { '200': { description: 'ok' } } },
        },
        '/thing': { get: { operationId: 'getThing', responses: { '200': { description: 'ok' } } } },
      },
    } as unknown as OpenAPIV3.Document;
    translateStainless(
      {
        resources: {
          things: { methods: { list: 'get /things' } },
          thing: { methods: { list: 'get /thing' } },
        },
      },
      api,
    );
    const n1 = opOf(api, '/things', 'get')['x-mcp-name'];
    const n2 = opOf(api, '/thing', 'get')['x-mcp-name'];
    expect(n1).toBe('list_thing');
    expect(n2).toBe('list_thing_2');
    expect(n1).not.toBe(n2);
  });
});

describe('translateStainless — unwrap edge cases', () => {
  it('unwraps a data envelope composed via allOf', () => {
    const api = {
      openapi: '3.0.0',
      info: { title: 'x', version: '1.0.0' },
      servers: [{ url: 'https://x' }],
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            responses: {
              '200': {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { type: 'object', properties: { id: { type: 'string' } } },
                        { type: 'object', properties: { data: { type: 'object' } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;
    const t = translateStainless({ settings: { unwrap_response: true } }, api);
    expect(opOf(api, '/things', 'post')['x-mcp-jq-filter']).toBe('.data');
    expect(t.unwrapped).toContain('POST /things');
  });

  it('refuses an unsafe unwrap_response value (no injection into the jq literal)', () => {
    const api = makeApi();
    const t = translateStainless({ settings: { unwrap_response: "data'); evil(" } }, api);
    expect(opOf(api, '/accounts', 'post')['x-mcp-jq-filter']).toBeUndefined();
    expect(t.unwrapped).toHaveLength(0);
    expect(t.warnings.join('\n')).toMatch(/unwrap_response/);
  });
});

describe('naming helpers', () => {
  it('toolNameFromTree handles chains child-first', () => {
    expect(toolNameFromTree('create', ['accounts'])).toBe('create_account');
    expect(toolNameFromTree('del', ['accounts'])).toBe('delete_account');
    expect(toolNameFromTree('create', ['cards', 'issuing'])).toBe('create_issuing_card');
  });

  it('singularize handles common plurals without mangling', () => {
    expect(singularize('accounts')).toBe('account');
    expect(singularize('cards')).toBe('card');
    expect(singularize('companies')).toBe('company');
    expect(singularize('addresses')).toBe('address');
    expect(singularize('status')).toBe('status'); // not "statu"
    expect(singularize('issuing')).toBe('issuing');
  });
});

describe('parseStainlessConfig / resolveSpecPath', () => {
  it('parses YAML', () => {
    const cfg = parseStainlessConfig(
      'openapi:\n  path: ./openapi.yml\nenvironments:\n  production: https://x',
    );
    expect((cfg.openapi as { path: string }).path).toBe('./openapi.yml');
  });

  it('throws on a non-object document', () => {
    expect(() => parseStainlessConfig('- 1\n- 2')).toThrow(/object/);
  });

  it('resolves a relative spec path against the config dir', () => {
    const p = resolveSpecPath({ openapi: { path: 'openapi.yml' } }, '/proj/stainless.yml');
    expect(p).toBe('/proj/openapi.yml');
  });

  it('honours an explicit override and leaves URLs untouched', () => {
    expect(resolveSpecPath({ spec: 'a.yml' }, '/proj/stainless.yml', '/other/b.yml')).toBe(
      '/other/b.yml',
    );
    expect(resolveSpecPath({ openapi: 'https://x/openapi.yml' }, '/proj/stainless.yml')).toBe(
      'https://x/openapi.yml',
    );
  });

  it('returns undefined when no spec is referenced', () => {
    expect(resolveSpecPath({}, '/proj/stainless.yml')).toBeUndefined();
  });
});
