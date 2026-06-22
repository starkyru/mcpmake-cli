import { describe, it, expect } from 'vitest';
import { normalizeTree, treeFingerprint } from '../../src/emitter/normalize-tree.js';
import type { CodeUnit } from '../../src/emitter/code-writer.js';

describe('normalizeTree', () => {
  it('sorts byte-wise by path and is independent of input order', () => {
    const a: CodeUnit[] = [
      { filePath: 'src/index.ts', content: 'i' },
      { filePath: 'package.json', content: 'p' },
      { filePath: 'src/tools/foo.ts', content: 'f' },
    ];
    const b: CodeUnit[] = [a[2], a[0], a[1]];
    const expected: CodeUnit[] = [
      { filePath: 'package.json', content: 'p' },
      { filePath: 'src/index.ts', content: 'i' },
      { filePath: 'src/tools/foo.ts', content: 'f' },
    ];
    expect(normalizeTree(a)).toEqual(expected);
    expect(normalizeTree(b)).toEqual(expected);
  });

  it('canonicalizes path spelling: backslashes, leading ./, and doubled slashes', () => {
    const out = normalizeTree([
      { filePath: 'src\\tools\\foo.ts', content: 'f' },
      { filePath: './package.json', content: 'p' },
      { filePath: 'src//index.ts', content: 'i' },
    ]);
    expect(out.map((u) => u.filePath)).toEqual([
      'package.json',
      'src/index.ts',
      'src/tools/foo.ts',
    ]);
  });

  it('collapses an exact duplicate (same path + same content) to one unit', () => {
    const out = normalizeTree([
      { filePath: 'a.ts', content: 'x' },
      { filePath: './a.ts', content: 'x' },
    ]);
    expect(out).toEqual([{ filePath: 'a.ts', content: 'x' }]);
  });

  it('throws on a path emitted twice with DIFFERENT content (real collision)', () => {
    expect(() =>
      normalizeTree([
        { filePath: 'a.ts', content: 'one' },
        { filePath: 'a.ts', content: 'two' },
      ]),
    ).toThrow(/conflicting duplicate path "a\.ts"/);
  });

  it('throws on an empty/invalid path', () => {
    expect(() => normalizeTree([{ filePath: '', content: 'x' }])).toThrow(/empty or invalid/);
    expect(() => normalizeTree([{ filePath: './', content: 'x' }])).toThrow(/empty or invalid/);
  });

  it('throws on a `..` traversal segment (the gate must not pass an escaping path)', () => {
    for (const bad of ['..', '../x', 'a/../b', './ok/../bad']) {
      expect(() => normalizeTree([{ filePath: bad, content: 'x' }])).toThrow(/empty or invalid/);
    }
  });

  it('collapses mid-path `/./` and trailing `/` so disk-equivalent paths dedup or conflict', () => {
    // foo/./bar, foo//bar, foo/bar/ all resolve to foo/bar on disk → same content dedups to one.
    const out = normalizeTree([
      { filePath: 'foo/./bar', content: 'x' },
      { filePath: 'foo//bar', content: 'x' },
      { filePath: 'foo/bar/', content: 'x' },
    ]);
    expect(out).toEqual([{ filePath: 'foo/bar', content: 'x' }]);
    // ...and DIFFERENT content at a disk-equivalent path is now correctly surfaced as a conflict.
    expect(() =>
      normalizeTree([
        { filePath: 'foo/bar', content: 'one' },
        { filePath: 'foo/./bar', content: 'two' },
      ]),
    ).toThrow(/conflicting duplicate path/);
  });

  it('does not mutate the input array', () => {
    const input: CodeUnit[] = [
      { filePath: 'b.ts', content: '2' },
      { filePath: 'a.ts', content: '1' },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeTree(input);
    expect(input).toEqual(snapshot);
  });
});

describe('treeFingerprint', () => {
  it('is identical for the same logical tree regardless of order or path spelling', () => {
    const a: CodeUnit[] = [
      { filePath: 'src/index.ts', content: 'i' },
      { filePath: 'package.json', content: 'p' },
    ];
    const b: CodeUnit[] = [
      { filePath: './package.json', content: 'p' },
      { filePath: 'src\\index.ts', content: 'i' },
    ];
    expect(treeFingerprint(a)).toBe(treeFingerprint(b));
  });

  it('changes when any file content changes', () => {
    const base: CodeUnit[] = [{ filePath: 'a.ts', content: 'x' }];
    const changed: CodeUnit[] = [{ filePath: 'a.ts', content: 'y' }];
    expect(treeFingerprint(changed)).not.toBe(treeFingerprint(base));
  });

  it('changes when a file is added', () => {
    const base: CodeUnit[] = [{ filePath: 'a.ts', content: 'x' }];
    const added: CodeUnit[] = [...base, { filePath: 'b.ts', content: 'y' }];
    expect(treeFingerprint(added)).not.toBe(treeFingerprint(base));
  });

  it('is injective across the path/content boundary (no delimiter collision)', () => {
    // Moving a byte from the path into the content must NOT collide — length-prefixing guards it.
    const t1: CodeUnit[] = [{ filePath: 'ab', content: 'c' }];
    const t2: CodeUnit[] = [{ filePath: 'a', content: 'bc' }];
    expect(treeFingerprint(t1)).not.toBe(treeFingerprint(t2));
  });

  it('returns a 64-char hex sha-256 digest', () => {
    expect(treeFingerprint([{ filePath: 'a.ts', content: 'x' }])).toMatch(/^[0-9a-f]{64}$/);
  });
});
