import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverlay } from '../../src/parser/overlay-loader.js';
import { logger } from '../../src/utils/logger.js';

const dirs: string[] = [];
function writeOverlay(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpmake-ovl-'));
  dirs.push(dir);
  const p = join(dir, 'overlay.yaml');
  writeFileSync(p, content, 'utf-8');
  return p;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A4-1: ReDoS regression — wildcardMatch is a linear two-pointer glob scan, so
// multi-`*` patterns can't trigger catastrophic backtracking. `*` still matches
// across `/` (OpenAPI path keys legitimately contain separators), so semantics
// are preserved vs the old `.*` regex.
// ---------------------------------------------------------------------------
describe('overlay-loader A4-1 ReDoS regression (wildcardMatch)', () => {
  it('a bare `*` matches every path key (including slash-containing keys)', async () => {
    const overlay = writeOverlay(
      [
        'overlay: 1.0.0',
        'actions:',
        '  - target: "$.paths[\'*\']"',
        '    update:',
        '      x-touched: true',
      ].join('\n'),
    );
    const spec: Record<string, unknown> = {
      paths: {
        '/users': { get: {} },
        '/items': { get: {} },
      },
    };
    await applyOverlay(spec, overlay);
    expect((spec.paths as Record<string, unknown>)['/users']).toMatchObject({ 'x-touched': true });
    expect((spec.paths as Record<string, unknown>)['/items']).toMatchObject({ 'x-touched': true });
  });

  it('a single `*` matches across path separators (preserved `.*` semantics)', async () => {
    // `/users/*` matches both `/users/123` and `/users/123/profile`: a path key
    // is a flat string and `*` spans `/`. (Behavior is unchanged from the old
    // regex; the fix only removes the backtracking, not the matching semantics.)
    const overlay = writeOverlay(
      [
        'overlay: 1.0.0',
        'actions:',
        '  - target: "$.paths[\'/users/*\']"',
        '    update:',
        '      x-touched: true',
      ].join('\n'),
    );
    const spec: Record<string, unknown> = {
      paths: {
        '/users/123': { get: {} },
        '/users/123/profile': { get: {} },
        '/orders/9': { get: {} },
      },
    };
    await applyOverlay(spec, overlay);
    const paths = spec.paths as Record<string, unknown>;
    expect(paths['/users/123']).toMatchObject({ 'x-touched': true });
    expect(paths['/users/123/profile']).toMatchObject({ 'x-touched': true });
    // A non-`/users` prefix must not match the literal portion of the pattern.
    expect((paths['/orders/9'] as Record<string, unknown>)['x-touched']).toBeUndefined();
  });

  it('resolves an adversarial multi-wildcard non-matching pattern without hanging', async () => {
    // `/a*a*a*…*b` against a long non-matching key is the classic catastrophic
    // backtracking case for a `.*` regex. The linear matcher returns promptly.
    // No timing assertion — correctness/termination is the contract.
    const star = '/a' + 'a*'.repeat(15) + 'b'; // many `*`s, ends in a literal
    const overlay = writeOverlay(
      JSON.stringify({
        overlay: '1.0.0',
        actions: [{ target: `$.paths['${star}']`, update: { 'x-touched': true } }],
      }),
    );
    const spec: Record<string, unknown> = {
      paths: { ['/a' + 'a'.repeat(40) + 'c']: { get: {} } }, // ends in `c`, never matches
    };
    await applyOverlay(spec, overlay);
    // The non-matching key is left untouched and the call terminated.
    expect((spec.paths as Record<string, unknown>)['/a' + 'a'.repeat(40) + 'c']).not.toMatchObject({
      'x-touched': true,
    });
  });
});

// ---------------------------------------------------------------------------
// A4-2: Unbounded recursion in deepMerge
// ---------------------------------------------------------------------------
describe('overlay-loader A4-2 deepMerge depth cap', () => {
  // `deepMerge` only recurses when BOTH the target and source have a matching
  // nested object at a key. To exercise the depth cap, both the spec subtree and
  // the overlay `update` must carry a deep `child` chain — an attacker who
  // supplies both the spec and the overlay (e.g. in CI) controls both sides.
  function deepChain(levels: number, leaf: unknown): Record<string, unknown> {
    let node: Record<string, unknown> = { leaf };
    for (let i = 0; i < levels; i++) node = { child: node };
    return node;
  }

  it('does not throw RangeError on a deep merge (cap stops the recursion)', async () => {
    const overlay = writeOverlay(
      JSON.stringify({
        overlay: '1.0.0',
        actions: [{ target: '$.info', update: deepChain(200, 'new') }],
      }),
    );
    // Target side is also deep, so deepMerge genuinely recurses on both sides.
    const spec: Record<string, unknown> = { info: deepChain(200, 'orig') };
    // Must not throw RangeError: Maximum call stack size exceeded.
    await expect(applyOverlay(spec, overlay)).resolves.toBeUndefined();
  });

  it('still merges shallow updates correctly after the depth fix', async () => {
    const overlay = writeOverlay(
      [
        'overlay: 1.0.0',
        'actions:',
        '  - target: "$.info"',
        '    update:',
        '      version: "2.0.0"',
      ].join('\n'),
    );
    const spec: Record<string, unknown> = { info: { title: 'API', version: '1.0.0' } };
    await applyOverlay(spec, overlay);
    expect((spec.info as Record<string, unknown>).version).toBe('2.0.0');
    expect((spec.info as Record<string, unknown>).title).toBe('API');
  });

  it('emits a logger.warn when the depth cap is hit (R2-C)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const overlay = writeOverlay(
        JSON.stringify({
          overlay: '1.0.0',
          actions: [{ target: '$.info', update: deepChain(60, 'new') }],
        }),
      );
      // Both sides deep → deepMerge recurses past the depth=50 cap.
      const spec: Record<string, unknown> = { info: deepChain(60, 'orig') };
      await applyOverlay(spec, overlay);

      // At least one warning about the depth cap must have been emitted.
      const depthWarnings = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('50 levels'));
      expect(depthWarnings.length).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// R22-2: applyAction guard — action with no/invalid "target" is skipped, not fatal
// ---------------------------------------------------------------------------
describe('overlay-loader R22-2 missing/invalid target guard', () => {
  it('does not throw when an action has no "target" field, and still applies valid siblings', async () => {
    const overlay = writeOverlay(
      JSON.stringify({
        overlay: '1.0.0',
        actions: [
          // no target at all — should be silently skipped
          { update: { 'x-bad': true } },
          // empty-string target — should be silently skipped
          { target: '', update: { 'x-also-bad': true } },
          // whitespace-only target — should be silently skipped
          { target: '   ', update: { 'x-ws-bad': true } },
          // valid action that must still be applied
          { target: '$.info', update: { version: 'patched' } },
        ],
      }),
    );
    const spec: Record<string, unknown> = { info: { title: 'API', version: '1.0.0' } };

    await expect(applyOverlay(spec, overlay)).resolves.toBeUndefined();
    // The valid action applied
    expect((spec.info as Record<string, unknown>).version).toBe('patched');
    // None of the bad actions leaked into the spec
    expect((spec as Record<string, unknown>)['x-bad']).toBeUndefined();
  });

  it('emits a logger.warn for each skipped action with missing/invalid target', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const overlay = writeOverlay(
        JSON.stringify({
          overlay: '1.0.0',
          actions: [
            { update: { 'x-no-target': true } },
            { target: '', update: { 'x-empty': true } },
          ],
        }),
      );
      const spec: Record<string, unknown> = { info: {} };
      await applyOverlay(spec, overlay);

      const skippedWarns = warnSpy.mock.calls.filter(([msg]) =>
        String(msg).includes('missing/invalid "target"'),
      );
      expect(skippedWarns.length).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('overlay-loader prototype-pollution guard', () => {
  it('does not pollute Object.prototype via __proto__ in an update body', async () => {
    const overlay = writeOverlay(
      [
        'overlay: 1.0.0',
        'actions:',
        '  - target: "$.info"',
        '    update:',
        '      __proto__:',
        '        polluted: "yes"',
        '  - target: "$.__proto__.polluted2"',
        '    update:',
        '      x: "y"',
        '  - target: "$.constructor.prototype.polluted3"',
        '    update:',
        '      x: "y"',
      ].join('\n'),
    );

    const spec: Record<string, unknown> = { info: { title: 'orig' }, paths: {} };
    await applyOverlay(spec, overlay);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = {} as any;
    expect(probe.polluted).toBeUndefined();
    expect(probe.polluted2).toBeUndefined();
    expect(probe.polluted3).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);
  });

  it('still applies legitimate updates', async () => {
    const overlay = writeOverlay(
      [
        'overlay: 1.0.0',
        'actions:',
        '  - target: "$.info"',
        '    update:',
        '      title: "patched"',
      ].join('\n'),
    );
    const spec: Record<string, unknown> = { info: { title: 'orig' } };
    await applyOverlay(spec, overlay);
    expect((spec.info as Record<string, unknown>).title).toBe('patched');
  });
});
