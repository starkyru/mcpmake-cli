import { defineCommand } from 'citty';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadOpenApiSpec } from '@mcpmake/core';
import { extractOperations } from '@mcpmake/core';
import { detectAuthSchemes } from '@mcpmake/core';
import { buildSmokeSuite } from '@mcpmake/core';
import { renderTemplate } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import { fail } from '@mcpmake/core';
import { pathExists } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

/** Slugify a spec title into a safe suite label (JSON-embedded, so cosmetic only). */
function deriveName(api: OpenAPIV3.Document): string {
  const title = api.info?.title;
  if (typeof title !== 'string' || title.trim() === '') return 'api';
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug || 'api';
}

export default defineCommand({
  meta: {
    name: 'test-scaffold',
    description: 'Generate a functional smoke-test suite (test/smoke.test.ts) from an OpenAPI spec',
  },
  args: {
    spec: {
      type: 'positional',
      description: 'Path to the OpenAPI spec',
      required: true,
    },
    project: {
      type: 'string',
      alias: 'p',
      description: 'Generated project to write test/smoke.test.ts into',
      required: true,
    },
    'base-url': {
      type: 'string',
      alias: 'b',
      description:
        'Base URL baked as the SMOKE_BASE_URL fallback (defaults to spec servers[0].url)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite an existing test/smoke.test.ts',
      default: false,
    },
  },
  async run({ args }) {
    const { api } = await loadOpenApiSpec(args.spec);
    const { operations, baseUrl, securitySchemes } = extractOperations(api as OpenAPIV3.Document);
    const { authSchemes } = detectAuthSchemes(securitySchemes ?? {});

    const suite = buildSmokeSuite(operations);
    if (suite.cases.length === 0 && !suite.chain) {
      return await fail(
        'No read-only operations with usable examples found — nothing to scaffold. Add example/default/enum values to your spec parameters.',
      );
    }

    const resolvedBase = (args['base-url'] as string | undefined) ?? baseUrl ?? '';
    // Only the fields the generated auth helper needs — never any secret value.
    const authView = authSchemes.map((s) => ({
      type: s.type,
      envVarName: s.envVarName,
      in: s.in ?? null,
      headerName: s.headerName ?? null,
    }));

    const content = renderTemplate('smoke-test.ts', {
      serverNameJson: JSON.stringify(deriveName(api as OpenAPIV3.Document)),
      suiteJson: JSON.stringify(suite.cases),
      authJson: JSON.stringify(authView),
      baseUrlJson: JSON.stringify(resolvedBase),
      chainJson: JSON.stringify(suite.chain ?? null),
      hasChain: Boolean(suite.chain),
    });

    const outPath = resolve(args.project, 'test/smoke.test.ts');
    if ((await pathExists(outPath)) && !args.force) {
      return await fail(`Refusing to overwrite ${outPath} (use --force to replace it).`);
    }

    await mkdir(resolve(args.project, 'test'), { recursive: true });
    await writeFile(outPath, content, 'utf-8');

    logger.success(
      `Wrote ${suite.cases.length} smoke case(s)${suite.chain ? ' + 1 chained flow' : ''} to test/smoke.test.ts`,
    );
    for (const s of suite.skipped) {
      logger.info(`Skipped ${s.operationId}: ${s.reason}`);
    }
    logger.info('Run it: SMOKE_BASE_URL=<url> <auth env vars> npx vitest run test/smoke.test.ts');
  },
});
