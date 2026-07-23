import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import verifyCommand from '../../src/commands/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(__dirname, '..', 'fixtures', 'petstore.yaml');

function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
}

/** Stub global fetch, capturing requested URLs, returning a fixed JSON body. */
function stubFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fn = vi.fn(async (url: string | URL) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, urls };
}

describe('verify --live', () => {
  beforeEach(() => {
    // The command reads process.env for auth; keep the run credential-free.
    delete process.env.BEARER_TOKEN;
    delete process.env.API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes when the live response matches, replaying only resolvable read-only ops', async () => {
    // petstore: listPets (GET /pets → array) is the only resolvable read-only op.
    // showPetById is skipped (no {petId} example); createPet/deletePet are writes.
    const { fn, urls } = stubFetch([{ id: 1, name: 'rex' }]);
    const exitSpy = spyOnExit();
    // --format json must keep stdout pure JSON (no human log lines), so a CI
    // pipeline can parse it. logger.* uses consola, not console.log, so the only
    // console.log call in this mode is the report itself.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: SPEC, live: true, 'base-url': 'https://api.test', format: 'json' },
        } as never),
      ).resolves.toBeUndefined();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(urls).toEqual(['https://api.test/pets']);

      expect(logSpy).toHaveBeenCalledTimes(1);
      const printed = logSpy.mock.calls[0][0] as string;
      const report = JSON.parse(printed); // must not throw — pure JSON
      expect(report.counts).toEqual({ ok: 1, drift: 0, skipped: 3, error: 0 });
      expect(report.failed).toBe(false);
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('fails (exit 1) when the live response shape drifts from the spec', async () => {
    // listPets declares an array 2xx; returning an object is a type-mismatch drift.
    stubFetch({ not: 'an array' });
    const exitSpy = spyOnExit();
    try {
      await expect(
        verifyCommand.run!({
          args: { spec: SPEC, live: true, 'base-url': 'https://api.test', format: 'json' },
        } as never),
      ).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('fails when neither a project nor --live is given', async () => {
    const exitSpy = spyOnExit();
    try {
      await expect(verifyCommand.run!({ args: { spec: SPEC } } as never)).rejects.toThrow(
        'process.exit called',
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
