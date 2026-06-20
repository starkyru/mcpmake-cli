import { describe, it, expect } from 'vitest';
import { extractJsonObject, extractJsonValue } from '../../src/utils/json-extract.js';

describe('extractJsonObject (L-jsonparse)', () => {
  it('returns a bare object unchanged', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('strips ```json fences around the object', () => {
    const text = '```json\n{"a":1,"b":[2,3]}\n```';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ a: 1, b: [2, 3] });
  });

  it('ignores leading and trailing prose', () => {
    const text = 'Sure! Here is the spec:\n{"ok":true}\nHope this helps!';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ ok: true });
  });

  it('ignores braces inside string values', () => {
    const text = '{"tpl":"a${b}c","obj":"}{"}';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ tpl: 'a${b}c', obj: '}{' });
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"q":"he said \\"hi\\" }"}';
    expect(JSON.parse(extractJsonObject(text)!)).toEqual({ q: 'he said "hi" }' });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });

  it('returns null when braces never balance (truncated output)', () => {
    expect(extractJsonObject('{"a":1, "b":')).toBeNull();
  });

  it('returns the first balanced object when several are present', () => {
    expect(extractJsonObject('prefix {"first":1} then {"second":2}')).toBe('{"first":1}');
  });
});

describe('extractJsonValue (object or array)', () => {
  it('extracts a top-level array', () => {
    const text = 'Here you go:\n```json\n[{"a":1},{"b":2}]\n```';
    expect(JSON.parse(extractJsonValue(text)!)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('extracts a top-level object', () => {
    expect(JSON.parse(extractJsonValue('prose {"x":1} more')!)).toEqual({ x: 1 });
  });

  it('picks whichever delimiter opens first', () => {
    // Array opens before the object → array wins.
    expect(extractJsonValue('[1, {"a":2}]')).toBe('[1, {"a":2}]');
    // Object opens before the array → object wins.
    expect(extractJsonValue('{"a":[1,2]}')).toBe('{"a":[1,2]}');
  });

  it('ignores brackets inside string values', () => {
    expect(JSON.parse(extractJsonValue('["a]b","c["]')!)).toEqual(['a]b', 'c[']);
  });

  it('returns null on malformed / unbalanced input', () => {
    expect(extractJsonValue('[1, 2')).toBeNull();
    expect(extractJsonValue('nothing structured')).toBeNull();
  });
});
