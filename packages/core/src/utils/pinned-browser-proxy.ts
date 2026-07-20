/**
 * Loopback HTTP proxy for browser-driven crawls.
 *
 * Chromium sends every HTTP request and HTTPS CONNECT tunnel through this
 * proxy. The proxy accepts only one validated hostname and port, and dials its
 * already resolved IP address, so Chromium never gets a second chance to
 * resolve a rebinding DNS name. All other targets — including literal private
 * IPs reached by redirects — receive 403 before a socket is opened.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface BrowserHostPin {
  hostname: string;
  address: string;
  port: number;
}

export interface PinnedBrowserProxy {
  /** Playwright's `proxy.server` value. */
  server: string;
  close(): Promise<void>;
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isPinnedTarget(hostname: string, port: number, pin: BrowserHostPin): boolean {
  return normalizeHost(hostname) === normalizeHost(pin.hostname) && port === pin.port;
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Start a loopback-only proxy that can connect exclusively to {@link pin}. */
export async function startPinnedBrowserProxy(pin: BrowserHostPin): Promise<PinnedBrowserProxy> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    // HTTP proxy requests must use an absolute URL. Reject relative-form input
    // instead of deriving a destination from Host, which could be attacker-set.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      !isPinnedTarget(target.hostname, port, pin)
    ) {
      res.writeHead(403).end();
      return;
    }

    // Plain HTTP proxy traffic. HTTPS normally arrives through the CONNECT
    // handler below, but preserve HTTPS support defensively by rejecting it:
    // forwarding it here would terminate TLS and change browser semantics.
    if (target.protocol !== 'http:') {
      res.writeHead(501).end();
      return;
    }
    const upstream = http.request(
      {
        host: pin.address,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('connect', (req, clientSocket, head) => {
    // CONNECT authority form is host:port. URL parsing handles bracketed IPv6
    // correctly once a scheme is supplied.
    let target: URL;
    try {
      target = new URL(`http://${req.url ?? ''}`);
    } catch {
      reject(clientSocket, 400, 'Bad Request');
      return;
    }
    const port = target.port ? Number(target.port) : 443;
    if (!isPinnedTarget(target.hostname, port, pin)) {
      reject(clientSocket, 403, 'Forbidden');
      return;
    }
    const upstream = net.connect({ host: pin.address, port });
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.once('error', () => {
      if (!clientSocket.destroyed) reject(clientSocket, 502, 'Bad Gateway');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    server: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
