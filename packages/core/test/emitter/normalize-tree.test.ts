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

  it('fully collapses repeated `/./` and trailing `/.` (segment-based, idempotent)', () => {
    // The old regex chain left `foo/././bar` as `foo/./bar` and `a/.` as `a/.`, so these
    // disk-equivalent spellings did NOT dedup/conflict. Segment canonicalization fixes both.
    const out = normalizeTree([
      { filePath: 'foo/././bar', content: 'x' },
      { filePath: 'foo/bar', content: 'x' },
      { filePath: 'a/.', content: 'y' },
      { filePath: 'a', content: 'y' },
    ]);
    expect(out).toEqual([
      { filePath: 'a', content: 'y' },
      { filePath: 'foo/bar', content: 'x' },
    ]);
    // A disk-equivalent path spelled `foo/././bar` with DIFFERENT content now conflicts.
    expect(() =>
      normalizeTree([
        { filePath: 'foo/bar', content: 'one' },
        { filePath: 'foo/././bar', content: 'two' },
      ]),
    ).toThrow(/conflicting duplicate path/);
  });

  it('is idempotent: normalizeTree(normalizeTree(x)) equals normalizeTree(x)', () => {
    const input: CodeUnit[] = [
      { filePath: 'foo/././bar', content: 'x' },
      { filePath: './deep//nested/./file.ts', content: 'y' },
    ];
    const once = normalizeTree(input);
    expect(normalizeTree(once)).toEqual(once);
  });

  it('rejects an absolute path instead of silently stripping the root', () => {
    for (const bad of ['/etc/x', '/', '\\\\server\\share']) {
      expect(() => normalizeTree([{ filePath: bad, content: 'x' }])).toThrow(
        /absolute file path not allowed/,
      );
    }
  });

  it('normalizes an empty tree to an empty array', () => {
    expect(normalizeTree([])).toEqual([]);
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

  it('matches a golden digest (independently derived) so a silent format change is caught', () => {
    // Expected value derived OUT OF BAND from the documented serialization, not from this code:
    //   printf 'mcpmake-tree\n1\n4\na.ts\n1\nx\n' | shasum -a 256
    // A relational "same tree → same hash" assert cannot catch a serialization-format change
    // (both sides change together); a pinned golden literal can.
    expect(treeFingerprint([{ filePath: 'a.ts', content: 'x' }])).toBe(
      '0dd34bd8c1a9645a32200bccbf2d81ade7e04000b4ac607b39d85da19ef33852',
    );
  });

  it('fingerprints an empty tree to a stable digest', () => {
    // printf 'mcpmake-tree\n0\n' | shasum -a 256
    expect(treeFingerprint([])).toBe(
      '0f9eccc4d68be325929f8ad10642b10335eb3b793de96128b2dea999c1a783d4',
    );
  });
});
