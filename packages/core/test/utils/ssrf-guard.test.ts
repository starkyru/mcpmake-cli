import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPrivateOrReservedIp, assertPublicUrl } from '../../src/utils/ssrf-guard.js';

describe('isPrivateOrReservedIp', () => {
  it('flags private/loopback/link-local/reserved IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
      '255.255.255.255', // broadcast
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it('flags private IPv6 and IPv4-mapped private addresses', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6', () => {
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('returns false for non-IP strings', () => {
    expect(isPrivateOrReservedIp('example.com')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  afterEach(() => {
    delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/non-http/);
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow(/non-http/);
  });

  it('rejects literal private/loopback/metadata hosts', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:8080/')).rejects.toThrow(/private\/reserved/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private\/reserved/,
    );
    await expect(assertPublicUrl('http://[::1]/')).rejects.toThrow(/private\/reserved/);
    await expect(assertPublicUrl('http://192.168.0.5/')).rejects.toThrow(/private\/reserved/);
  });

  it('rejects invalid URLs', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/Invalid URL/);
  });

  it('honors the MCPMAKE_ALLOW_PRIVATE_HOSTS escape hatch', async () => {
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertPublicUrl('http://127.0.0.1:8080/')).resolves.toBeUndefined();
  });

  it('allows a public literal IP without DNS', async () => {
    await expect(assertPublicUrl('https://1.1.1.1/')).resolves.toBeUndefined();
  });
});

// A3-H1 regression: WHATWG `new URL()` canonicalizes `[::ffff:127.0.0.1]` to the
// hexadecimal form `[::ffff:7f00:1]`, which a dotted-decimal-only check missed.
// These assert the binary classifier catches IPv4-mapped + NAT64 in BOTH forms.
describe('ssrf-guard — IPv4-mapped / NAT64 IPv6 (A3-H1)', () => {
  const original = process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
  beforeEach(() => delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS);
  afterEach(() => {
    if (original === undefined) delete process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS;
    else process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = original;
  });

  const privateLiterals: Array<[string, string]> = [
    ['::ffff:7f00:1', 'hex 127.0.0.1 (loopback)'],
    ['::ffff:a9fe:a9fe', 'hex 169.254.169.254 (metadata)'],
    ['::ffff:0a00:0001', 'hex 10.0.0.1 (private)'],
    ['64:ff9b::7f00:1', 'NAT64 loopback (hex)'],
    ['64:ff9b::127.0.0.1', 'NAT64 loopback (dotted)'],
  ];
  for (const [ip, label] of privateLiterals) {
    it(`flags ${ip} (${label}) as private/reserved`, () => {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    });
  }

  it('allows a public IPv4-mapped literal (8.8.8.8) in hex and dotted form', () => {
    expect(isPrivateOrReservedIp('::ffff:0808:0808')).toBe(false);
    expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('rejects bracketed mapped/NAT64 private URLs without DNS', async () => {
    for (const url of [
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::ffff:0a00:0001]/',
      'http://[64:ff9b::7f00:1]/',
    ]) {
      await expect(assertPublicUrl(url)).rejects.toThrow(/private\/reserved/);
    }
  });

  it('allows a bracketed public mapped literal [::ffff:0808:0808] without DNS', async () => {
    await expect(assertPublicUrl('http://[::ffff:0808:0808]/')).resolves.toBeUndefined();
  });

  it('honors the escape hatch for a mapped loopback', async () => {
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).resolves.toBeUndefined();
  });
});
