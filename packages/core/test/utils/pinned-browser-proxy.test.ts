import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startPinnedBrowserProxy,
  type PinnedBrowserProxy,
} from '../../src/utils/pinned-browser-proxy.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

function proxyPort(proxy: PinnedBrowserProxy): number {
  return Number(new URL(proxy.server).port);
}

async function connectThroughProxy(port: number, authority: string): Promise<net.Socket> {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const header = await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
    socket.once('error', reject);
  });
  if (!header.startsWith('HTTP/1.1 200')) {
    socket.destroy();
    throw new Error(header);
  }
  return socket;
}

describe('pinned browser proxy', () => {
  it('CONNECTs only to the pinned address, preserving the requested hostname', async () => {
    const upstream = net.createServer((socket) => socket.pipe(socket));
    const upstreamPort = await listen(upstream);
    const proxy = await startPinnedBrowserProxy({
      hostname: 'public.example',
      address: '127.0.0.1',
      port: upstreamPort,
    });
    closers.push(() => proxy.close());

    const socket = await connectThroughProxy(proxyPort(proxy), `public.example:${upstreamPort}`);
    socket.write('pinned');
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
      socket.once('error', reject);
    });
    socket.end();
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));

    expect(echoed).toBe('pinned');
  });

  it('refuses an unpinned host or port before opening an upstream socket', async () => {
    const proxy = await startPinnedBrowserProxy({
      hostname: 'public.example',
      address: '127.0.0.1',
      port: 443,
    });
    closers.push(() => proxy.close());
    const port = proxyPort(proxy);
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write('CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n');
    const response = await new Promise<string>((resolve, reject) => {
      socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
      socket.once('error', reject);
    });
    socket.destroy();

    expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/);

    const wrongPortSocket = net.connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      wrongPortSocket.once('connect', resolve);
      wrongPortSocket.once('error', reject);
    });
    wrongPortSocket.write(
      'CONNECT public.example:444 HTTP/1.1\r\nHost: public.example:444\r\n\r\n',
    );
    const wrongPortResponse = await new Promise<string>((resolve, reject) => {
      wrongPortSocket.once('data', (chunk) => resolve(chunk.toString('utf8')));
      wrongPortSocket.once('error', reject);
    });
    wrongPortSocket.destroy();

    expect(wrongPortResponse).toMatch(/^HTTP\/1\.1 403 Forbidden/);
  });

  it('forwards plain HTTP only to the pinned address', async () => {
    const upstream = http.createServer((req, res) => res.end(`${req.method} ${req.url}`));
    const upstreamPort = await listen(upstream);
    const proxy = await startPinnedBrowserProxy({
      hostname: 'public.example',
      address: '127.0.0.1',
      port: upstreamPort,
    });
    closers.push(() => proxy.close());

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: proxyPort(proxy),
          path: `http://public.example:${upstreamPort}/through-proxy?x=1`,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      request.once('error', reject);
      request.end();
    });

    expect(response).toEqual({ status: 200, body: 'GET /through-proxy?x=1' });
  });
});
