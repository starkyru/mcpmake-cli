import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for outbound requests driven by untrusted input — crawled links,
 * recorded navigations, and remote OpenAPI spec/`$ref` URLs.
 *
 * The browser crawler/recorder and the spec loader all fetch URLs that originate
 * from user input or from an LLM/page following links. Without a host check they
 * can be steered at `localhost`, RFC1918 intranets, or the cloud metadata
 * endpoint (`169.254.169.254`). This module resolves a URL's host and rejects
 * any that points at a private, loopback, link-local, or otherwise reserved
 * address.
 *
 * Residual limitation (documented, not closed here): this checks at request time
 * but does not pin DNS at the socket, so a TOCTOU/DNS-rebinding attacker who
 * flips a record between this lookup and the browser's own connect can still slip
 * through. Full DNS-pinning would require intercepting at the socket layer.
 *
 * Escape hatch: set `MCPMAKE_ALLOW_PRIVATE_HOSTS=1` to allow private/loopback
 * targets (local development against `localhost` test servers).
 */

const ALLOW_ENV = 'MCPMAKE_ALLOW_PRIVATE_HOSTS';

export function privateHostsAllowed(): boolean {
  return process.env[ALLOW_ENV] === '1' || process.env[ALLOW_ENV] === 'true';
}

/** Parse a dotted-quad IPv4 string into its four octets, or null if malformed. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function isPrivateIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1 (RFC 5737)
  if (a === 198 && b === 51 && o[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2 (RFC 5737)
  if (a === 203 && b === 0 && o[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3 (RFC 5737)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking (RFC 2544)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.* broadcast
  return false;
}

/**
 * Parse an IPv6 literal into its 8 hextets (16-bit groups), or null if malformed.
 * Handles `::` compression (incl. leading/trailing `::`) and a trailing embedded
 * dotted-decimal IPv4 (`::ffff:127.0.0.1` → its low 32 bits become two hextets).
 */
function ipv6Hextets(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  // Drop a zone id (`fe80::1%eth0`) if present — irrelevant to classification.
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip === '') return null;

  // Expand a trailing embedded IPv4 (e.g. `::ffff:1.2.3.4`) into two hextets.
  const lastColon = ip.lastIndexOf(':');
  const tail = lastColon === -1 ? ip : ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = ipv4Octets(tail);
    if (!octets) return null;
    const [a, b, c, d] = octets;
    const hextetTail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    ip = (lastColon === -1 ? '' : ip.slice(0, lastColon + 1)) + hextetTail;
  }

  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (g === '' || g.length > 4 || !/^[0-9a-f]+$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const dbl = ip.indexOf('::');
  let groups: number[];
  if (dbl === -1) {
    const g = parseGroups(ip);
    if (!g || g.length !== 8) return null;
    groups = g;
  } else {
    if (ip.indexOf('::', dbl + 1) !== -1) return null; // more than one `::`
    const head = parseGroups(ip.slice(0, dbl));
    const tailGroups = parseGroups(ip.slice(dbl + 2));
    if (!head || !tailGroups) return null;
    const fill = 8 - head.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tailGroups];
  }
  return groups.length === 8 ? groups : null;
}

function isPrivateIpv6(raw: string): boolean {
  const ip = raw.toLowerCase();
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified

  // Classify embedded IPv4 from the BINARY address, not a textual regex: WHATWG
  // `new URL()` canonicalizes `[::ffff:127.0.0.1]` to hex (`::ffff:7f00:1`), so a
  // dotted-decimal-only check misses the canonical form. We parse to hextets and
  // reconstruct the v4 octets from the low two groups for both IPv4-mapped
  // (`::ffff:X:Y`, the 6th hextet is 0xffff) and NAT64 (`64:ff9b::X:Y`).
  const h = ipv6Hextets(ip);
  if (h) {
    const reconstructV4 = (): string => {
      const [g6, g7] = [h[6], h[7]];
      return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    };
    // ::ffff:X:Y — IPv4-mapped (first 5 hextets 0, 6th = 0xffff).
    if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
      return isPrivateIpv4(reconstructV4());
    }
    // 64:ff9b::X:Y — NAT64 well-known prefix (64:ff9b::/96).
    if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
      return isPrivateIpv4(reconstructV4());
    }
  }

  // Belt-and-suspenders: keep the dotted-decimal textual path working too.
  const mapped = ip.match(/(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb'))
    return true; // fe80::/10 link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique-local
  if (ip.startsWith('fec') || ip.startsWith('fed') || ip.startsWith('fee') || ip.startsWith('fef'))
    return true; // fec0::/10 deprecated site-local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/** Whether `ip` (a literal IPv4 or IPv6 address) is private, loopback, or reserved. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return false; // not an IP literal
}

/**
 * Throw if `urlString` is not a public http(s) URL. Resolves the host via DNS and
 * rejects when any resolved address is private/loopback/link-local/reserved.
 * Honors the `MCPMAKE_ALLOW_PRIVATE_HOSTS` escape hatch.
 */
export async function assertPublicUrl(urlString: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing non-http(s) URL: ${urlString}`);
  }

  if (privateHostsAllowed()) return;

  // Strip IPv6 brackets from the hostname for literal checks.
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // Literal IP host — check directly, no DNS needed.
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(
        `Refusing to access private/reserved address ${host} (set ${ALLOW_ENV}=1 to allow).`,
      );
    }
    return;
  }

  // Hostname — resolve every address it maps to and reject if ANY is private.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error(`Cannot resolve host "${host}" to verify it is public; refusing request.`);
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(
        `Refusing request: host "${host}" resolves to private/reserved address ${address} ` +
          `(set ${ALLOW_ENV}=1 to allow).`,
      );
    }
  }
}
