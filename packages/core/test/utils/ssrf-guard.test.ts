import { describe, it, expect, afterEach } from 'vitest';
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
