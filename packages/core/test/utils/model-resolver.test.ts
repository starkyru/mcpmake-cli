import { describe, it, expect, vi } from 'vitest';

type FakeModel = { id: string; display_name: string; created_at: string };

function fakeClient(models: FakeModel[], opts: { throwOnList?: boolean; spy?: { calls: number } } = {}) {
  return {
    models: {
      list() {
        if (opts.spy) opts.spy.calls++;
        if (opts.throwOnList) throw new Error('network down');
        return (async function* () {
          for (const m of models) yield m;
        })();
      },
    },
  } as unknown as import('@anthropic-ai/sdk').default;
}

// Fresh import per case so the module-level per-tier cache starts empty.
async function freshResolveModel() {
  vi.resetModules();
  return (await import('../../src/utils/model-resolver.js')).resolveModel;
}

describe('resolveModel', () => {
  it('returns an explicit override without touching the Models API', async () => {
    const resolveModel = await freshResolveModel();
    const spy = { calls: 0 };
    const client = fakeClient([], { spy });
    expect(await resolveModel(client, 'balanced', 'claude-custom-x')).toBe('claude-custom-x');
    expect(spy.calls).toBe(0);
  });

  it('uses the preferred alias when the Models API lists it', async () => {
    const resolveModel = await freshResolveModel();
    const client = fakeClient([
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-09-01T00:00:00Z' },
      { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', created_at: '2025-10-01T00:00:00Z' },
    ]);
    expect(await resolveModel(client, 'balanced')).toBe('claude-sonnet-4-6');
  });

  it('falls back to the newest matching model when the preferred alias is retired', async () => {
    const resolveModel = await freshResolveModel();
    const client = fakeClient([
      { id: 'claude-sonnet-7-0-20280101', display_name: 'Claude Sonnet 7', created_at: '2028-01-01T00:00:00Z' },
      { id: 'claude-sonnet-9-0-20300101', display_name: 'Claude Sonnet 9', created_at: '2030-01-01T00:00:00Z' },
      { id: 'claude-haiku-5-0', display_name: 'Claude Haiku 5', created_at: '2029-01-01T00:00:00Z' },
    ]);
    // preferred 'claude-sonnet-4-6' absent → newest sonnet by created_at
    expect(await resolveModel(client, 'balanced')).toBe('claude-sonnet-9-0-20300101');
  });

  it('falls back to the preferred alias when no tier match is found', async () => {
    const resolveModel = await freshResolveModel();
    const client = fakeClient([
      { id: 'some-other-model', display_name: 'Other', created_at: '2030-01-01T00:00:00Z' },
    ]);
    expect(await resolveModel(client, 'fast')).toBe('claude-haiku-4-5');
  });

  it('falls back to the preferred alias when the Models API is unreachable', async () => {
    const resolveModel = await freshResolveModel();
    const client = fakeClient([], { throwOnList: true });
    expect(await resolveModel(client, 'balanced')).toBe('claude-sonnet-4-6');
  });

  it('caches the resolved model per tier (one Models API call per process)', async () => {
    const resolveModel = await freshResolveModel();
    const spy = { calls: 0 };
    const client = fakeClient(
      [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-09-01T00:00:00Z' }],
      { spy },
    );
    await resolveModel(client, 'balanced');
    await resolveModel(client, 'balanced');
    expect(spy.calls).toBe(1);
  });
});
