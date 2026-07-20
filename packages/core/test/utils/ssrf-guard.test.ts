import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPrivateOrReservedIp,
  assertPublicUrl,
  resolvePublicUrl,
} from '../../src/utils/ssrf-guard.js';

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

  it('flags TEST-NET-1/2/3 and benchmarking reserved IPv4 ranges (A4-14)', () => {
    // RFC 5737 documentation ranges + RFC 2544 benchmarking range. These must
    // never be reached; treat them as reserved like the other private blocks.
    for (const ip of [
      '192.0.2.0', // TEST-NET-1 network address
      '192.0.2.1', // TEST-NET-1
      '192.0.2.255', // TEST-NET-1 broadcast
      '198.51.100.0', // TEST-NET-2 network address
      '198.51.100.5', // TEST-NET-2
      '198.51.100.255', // TEST-NET-2 broadcast
      '203.0.113.0', // TEST-NET-3 network address
      '203.0.113.9', // TEST-NET-3
      '203.0.113.255', // TEST-NET-3 broadcast
      '198.18.0.0', // 198.18.0.0/15 benchmarking — low edge
      '198.18.0.1', // benchmarking
      '198.19.255.254', // benchmarking
      '198.19.255.255', // 198.18.0.0/15 — high edge
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it('does NOT over-block addresses adjacent to the new reserved ranges (A4-14)', () => {
    // One step outside each /24 or /15 boundary must stay public — proving the
    // checks are exact CIDR matches, not over-broad octet prefixes.
    for (const ip of [
      '192.0.1.255', // just below 192.0.2.0/24
      '192.0.3.0', // just above 192.0.2.0/24
      '198.51.99.255', // just below 198.51.100.0/24
      '198.51.101.0', // just above 198.51.100.0/24
      '203.0.112.255', // just below 203.0.113.0/24
      '203.0.114.1', // just above 203.0.113.0/24
      '198.17.255.255', // just below 198.18.0.0/15
      '198.20.0.1', // just above 198.18.0.0/15
    ]) {
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

  it('returns a concrete browser pin with the protocol-default port', async () => {
    await expect(resolvePublicUrl('https://1.1.1.1/path')).resolves.toMatchObject({
      hostname: '1.1.1.1',
      address: '1.1.1.1',
      family: 4,
      port: 443,
    });
  });

  it('rejects literal TEST-NET / benchmarking reserved hosts (A4-14)', async () => {
    for (const url of [
      'http://192.0.2.1/', // TEST-NET-1
      'http://198.51.100.5/', // TEST-NET-2
      'http://203.0.113.9/', // TEST-NET-3
      'http://198.18.0.1/', // benchmarking low edge
      'http://198.19.255.254/', // benchmarking high edge
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(/private\/reserved/);
    }
  });

  it('still allows hosts just outside the new reserved ranges (A4-14)', async () => {
    // Boundary-adjacent public literals must pass the URL guard unchanged.
    await expect(assertPublicUrl('http://198.20.0.1/')).resolves.toBeUndefined();
    await expect(assertPublicUrl('http://203.0.114.1/')).resolves.toBeUndefined();
  });

  it('honors the escape hatch for a reserved TEST-NET host (A4-14)', async () => {
    process.env.MCPMAKE_ALLOW_PRIVATE_HOSTS = '1';
    await expect(assertPublicUrl('http://192.0.2.1/')).resolves.toBeUndefined();
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
