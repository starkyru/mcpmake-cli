import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  confirmPush,
  detectTransport,
  buildSmitheryManifest,
  buildGlamaManifest,
} from '../../src/commands/publish.js';

describe('registry manifest builders (preview/write share these)', () => {
  const manifest = {
    name: 'petstore',
    version: '1.2.3',
    description: 'A petstore server',
    transport: 'stdio' as const,
    tools: [
      { name: 'list_pets', description: 'List pets' },
      { name: 'create_pet', description: 'Create a pet' },
    ],
  };

  it('buildSmitheryManifest maps name/description/version/transport/tools', () => {
    expect(buildSmitheryManifest(manifest)).toEqual({
      name: 'petstore',
      description: 'A petstore server',
      version: '1.2.3',
      transport: 'stdio',
      tools: [
        { name: 'list_pets', description: 'List pets' },
        { name: 'create_pet', description: 'Create a pet' },
      ],
    });
  });

  it('buildGlamaManifest emits the glama field order (version before description)', () => {
    expect(Object.keys(buildGlamaManifest(manifest))).toEqual([
      'name',
      'version',
      'description',
      'transport',
      'tools',
    ]);
    expect(buildGlamaManifest(manifest)).toMatchObject({ name: 'petstore', transport: 'stdio' });
  });
});

describe('detectTransport (A4-6) — reads src/index.ts, not a duplicate path', () => {
  let tmp: string;

  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('returns "stdio" when src/index.ts has no HTTP transport markers', async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-pub-'));
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src', 'index.ts'), '// stdio server\nserver.connect(transport);');
    expect(await detectTransport(tmp)).toBe('stdio');
  });

  it('returns "http" when src/index.ts contains StreamableHTTPServerTransport', async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-pub-'));
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(
      join(tmp, 'src', 'index.ts'),
      '// http server\nnew StreamableHTTPServerTransport({ sessionIdGenerator });',
    );
    expect(await detectTransport(tmp)).toBe('http');
  });

  it('returns "http" when src/index.ts contains SSEServerTransport', async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-pub-'));
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(
      join(tmp, 'src', 'index.ts'),
      'const t = new SSEServerTransport("/message", res);',
    );
    expect(await detectTransport(tmp)).toBe('http');
  });

  it('returns "stdio" when src/index.ts does not exist (no false positives)', async () => {
    tmp = await mkdtemp(resolve(tmpdir(), 'mcpmake-pub-'));
    // No src/ directory at all
    expect(await detectTransport(tmp)).toBe('stdio');
  });
});

describe('L-publishpush — publish --push requires confirmation', () => {
  const origStdin = process.stdin.isTTY;
  const origStdout = process.stdout.isTTY;
  const origCI = process.env.CI;

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: origStdin, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: origStdout, configurable: true });
    if (origCI === undefined) delete process.env.CI;
    else process.env.CI = origCI;
  });

  it('refuses to push in a non-interactive run without --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    delete process.env.CI;

    await expect(confirmPush('io.github.you/my-server', false)).resolves.toBe(false);
  });

  it('refuses to push in CI without --yes even on a TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    process.env.CI = 'true';

    await expect(confirmPush('io.github.you/my-server', false)).resolves.toBe(false);
  });

  it('proceeds when --yes is passed (explicit consent)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    delete process.env.CI;

    await expect(confirmPush('io.github.you/my-server', true)).resolves.toBe(true);
  });
});
