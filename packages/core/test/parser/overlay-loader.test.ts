import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOverlay } from '../../src/parser/overlay-loader.js';

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
      ['overlay: 1.0.0', 'actions:', '  - target: "$.info"', '    update:', '      title: "patched"'].join(
        '\n',
      ),
    );
    const spec: Record<string, unknown> = { info: { title: 'orig' } };
    await applyOverlay(spec, overlay);
    expect((spec.info as Record<string, unknown>).title).toBe('patched');
  });
});
