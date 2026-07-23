import { describe, it, expect } from 'vitest';
import { verifyLive } from '../../src/verify/verify-live.js';
import type { AuthScheme, OperationDescriptor, ResponseDescriptor } from '../../src/types/index.js';

function op(partial: Partial<OperationDescriptor>): OperationDescriptor {
  return {
    operationId: 'getThing',
    method: 'get',
    path: '/thing',
    tags: [],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...partial,
  };
}

const objResponse: ResponseDescriptor = {
  statusCode: '200',
  schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
};

/** A capturing fake fetch that returns a fixed JSON body + status. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('verifyLive', () => {
  it('reports ok when the live response matches the schema and hits the right URL', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
    });
    expect(report.counts.ok).toBe(1);
    expect(report.failed).toBe(false);
    expect(calls[0].url).toBe('https://api.test/thing');
    expect(calls[0].init.method).toBe('GET');
  });

  it('preserves a base-URL path prefix when joining the operation path', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test/v1',
      fetchImpl: fn,
    });
    expect(calls[0].url).toBe('https://api.test/v1/thing');
  });

  it('reports drift when a required field is missing', async () => {
    const { fn } = fakeFetch({});
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
    });
    expect(report.counts.drift).toBe(1);
    expect(report.failed).toBe(true);
    const r = report.results[0];
    expect(r.status).toBe('drift');
    expect(r.divergences).toEqual([
      { path: '$.id', kind: 'missing-required', expected: 'present', actual: 'absent' },
    ]);
  });

  it('skips write operations by default and never calls fetch for them', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const report = await verifyLive(
      [op({ operationId: 'createThing', method: 'post', responses: [objResponse] })],
      { baseUrl: 'https://api.test', fetchImpl: fn },
    );
    expect(report.counts.skipped).toBe(1);
    expect(report.results[0].reason).toContain('write method');
    expect(calls).toHaveLength(0);
  });

  it('replays write operations when includeWrites is set', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const report = await verifyLive(
      [op({ operationId: 'createThing', method: 'post', responses: [objResponse] })],
      { baseUrl: 'https://api.test', fetchImpl: fn, includeWrites: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe('POST');
    expect(report.counts.ok).toBe(1);
  });

  it('skips an operation whose required path param has no spec example', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const report = await verifyLive(
      [
        op({
          path: '/thing/{id}',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: [objResponse],
        }),
      ],
      { baseUrl: 'https://api.test', fetchImpl: fn },
    );
    expect(report.counts.skipped).toBe(1);
    expect(report.results[0].reason).toContain('no example for required path param "id"');
    expect(calls).toHaveLength(0);
  });

  it('substitutes a path param from its spec example', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    await verifyLive(
      [
        op({
          path: '/thing/{id}',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: '42' } },
          ],
          responses: [objResponse],
        }),
      ],
      { baseUrl: 'https://api.test', fetchImpl: fn },
    );
    expect(calls[0].url).toBe('https://api.test/thing/42');
  });

  it('reports a non-2xx response as an error (not schema drift)', async () => {
    const { fn } = fakeFetch({ message: 'nope' }, 404);
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
    });
    expect(report.counts.error).toBe(1);
    expect(report.results[0].status).toBe('error');
    expect(report.results[0].httpStatus).toBe(404);
    expect(report.failed).toBe(true);
  });

  it('applies bearer auth from env without leaking the token into results', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const authSchemes: AuthScheme[] = [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }];
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
      authSchemes,
      env: { BEARER_TOKEN: 'super-secret' },
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer super-secret');
    expect(JSON.stringify(report)).not.toContain('super-secret');
  });

  it('applies an apiKey-in-query credential to the URL', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const authSchemes: AuthScheme[] = [
      { type: 'apiKey', envVarName: 'API_KEY', in: 'query', headerName: 'api_key' },
    ];
    await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
      authSchemes,
      env: { API_KEY: 'k123' },
    });
    expect(calls[0].url).toContain('api_key=k123');
  });

  it('does not apply auth to a public operation (security: [])', async () => {
    const { fn, calls } = fakeFetch({ id: 1 });
    const authSchemes: AuthScheme[] = [{ type: 'http-bearer', envVarName: 'BEARER_TOKEN' }];
    await verifyLive([op({ securityOptional: true, responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
      authSchemes,
      env: { BEARER_TOKEN: 'secret' },
    });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('classifies an abort as a timeout error', async () => {
    const fn = (async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }) as unknown as typeof fetch;
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
    });
    expect(report.results[0].status).toBe('error');
    expect(report.results[0].reason).toBe('request timed out');
  });

  it('classifies a generic throw as a network error', async () => {
    const fn = (async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    }) as unknown as typeof fetch;
    const report = await verifyLive([op({ responses: [objResponse] })], {
      baseUrl: 'https://api.test',
      fetchImpl: fn,
    });
    expect(report.results[0].reason).toBe('network error');
  });

  it('rejects a non-http(s) base URL', async () => {
    const { fn } = fakeFetch({ id: 1 });
    await expect(
      verifyLive([op({ responses: [objResponse] })], {
        baseUrl: 'file:///etc/passwd',
        fetchImpl: fn,
      }),
    ).rejects.toThrow(/http/);
  });
});
