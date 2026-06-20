import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { buildResources, buildPrompts } from '../../src/transformer/resource-builder.js';
import { detectAuthSchemes } from '../../src/transformer/auth-detector.js';
import { generateSiteTools } from '../../src/site-transformer/tool-generator.js';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import { renderWorkerTemplate } from '../../src/emitter/worker-template-loader.js';
import { renderSiteTemplate } from '../../src/emitter/site-template-loader.js';
import { emitPythonProject } from '../../src/emitter/index.js';
import type { OperationDescriptor, ProjectManifest } from '../../src/types/index.js';
import type { OpenAPIV3 } from 'openapi-types';

/** Transpile rendered TS and fail on any syntactic diagnostic (proves no breakout). */
function assertParses(source: string, label: string): void {
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntactic = (result.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error,
  );
  const msgs = syntactic
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    .join('; ');
  expect(syntactic, `${label} did not parse: ${msgs}`).toHaveLength(0);
}

// Payloads engineered to break out of each literal context and run code.
const TS_STRING_BREAKOUT = "'); (globalThis as any).PWNED = 1; ('";
const TS_TEMPLATE_BREAKOUT = '`); (globalThis as any).PWNED = 1; //';
const DOLLAR_BREAKOUT = '${(globalThis as any).PWNED = 1}';

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listPets',
    method: 'get',
    path: '/pets',
    tags: ['pets'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('codegen injection hardening', () => {
  describe('API tool handler (node + worker)', () => {
    it('stays valid TS with adversarial x-mcp-name, operationId, description, jqFilter', () => {
      const op = makeOp({
        operationId: `evil${TS_STRING_BREAKOUT}`,
        path: '/pets/{petId}',
        summary: `summary ${TS_TEMPLATE_BREAKOUT} ${DOLLAR_BREAKOUT}`,
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        mcpExtensions: {
          name: `attacker${TS_STRING_BREAKOUT}`,
          description: `desc ${TS_TEMPLATE_BREAKOUT}`,
          jqFilter: "'); throw 1; ('",
        },
      });
      const tool = buildToolDefinition(op);

      // name must be a safe identifier slug, never containing quotes/backticks
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);

      assertParses(renderTemplate('tool-handler.ts', tool), 'node tool-handler');
      assertParses(renderWorkerTemplate('tool-handler.ts', tool), 'worker tool-handler');
    });

    it('title from raw x-mcp-name does not break the single-quoted literal', () => {
      const tool = buildToolDefinition(
        makeOp({ mcpExtensions: { name: TS_STRING_BREAKOUT } }),
      );
      const src = renderTemplate('tool-handler.ts', tool);
      assertParses(src, 'title injection');
      // The payload's `'` must be escaped (preceded by a backslash), i.e. it never
      // appears as a bare closing quote that would terminate the title literal.
      expect(src).not.toMatch(/[^\\]'\); \(globalThis/);
      expect(tool.title).toContain("\\'");
    });
  });

  describe('resources and prompts', () => {
    it('stays valid TS with adversarial path and tag', () => {
      const ops = [
        makeOp({ operationId: `r${TS_STRING_BREAKOUT}`, method: 'get', path: `/a${TS_TEMPLATE_BREAKOUT}` }),
        makeOp({
          operationId: 'detail',
          method: 'get',
          path: '/items/{id}',
          parameters: [{ name: `id${TS_STRING_BREAKOUT}`, in: 'path', required: true, schema: {} }],
        }),
      ];
      const resources = buildResources(ops);
      assertParses(renderTemplate('resources.ts', { resources }), 'resources');

      const prompts = buildPrompts([
        makeOp({ tags: [`tag${TS_STRING_BREAKOUT}`] }),
      ]);
      expect(prompts[0].name).toMatch(/^[a-zA-Z0-9_-]+$/);
      assertParses(renderTemplate('prompts.ts', { prompts }), 'prompts');
    });
  });

  describe('auth provider', () => {
    it('sanitizes an adversarial apiKey header name and env var', () => {
      const schemes: Record<string, OpenAPIV3.SecuritySchemeObject> = {
        evil: {
          type: 'apiKey',
          in: 'header',
          name: "X-Key']; (globalThis as any).PWNED = 1; ['",
        } as OpenAPIV3.ApiKeySecuritySchemeObject,
      };
      const { authSchemes } = detectAuthSchemes(schemes);
      expect(authSchemes[0].headerName).toMatch(/^[A-Za-z0-9_-]+$/);
      assertParses(
        renderTemplate('auth-provider.ts', { authSchemes, hasOAuth: false }),
        'auth-provider',
      );
    });
  });

  describe('site tool handlers (crawled DOM)', () => {
    it('stays valid TS when DOM text contains backticks / ${} / quotes', () => {
      const site = {
        baseUrl: 'https://example.com',
        pages: [
          {
            pageId: 'p1',
            url: 'https://example.com/x',
            title: `Title ${TS_TEMPLATE_BREAKOUT} ${DOLLAR_BREAKOUT}`,
            forms: [
              {
                formId: 'form_1',
                semanticName: 'login',
                description: `form ${TS_TEMPLATE_BREAKOUT}`,
                selector: { primary: '#f', fallbacks: [], strategy: 'id', confidence: 0.9 },
                fields: [
                  {
                    name: 'email',
                    fieldType: 'text',
                    selector: { primary: '#e', fallbacks: [], strategy: 'id', confidence: 0.9 },
                  },
                ],
              },
            ],
            buttons: [
              {
                text: `Buy ${TS_TEMPLATE_BREAKOUT}`,
                semanticAction: 'buy',
                selector: { primary: '#b', fallbacks: [], strategy: 'id', confidence: 0.9 },
              },
            ],
            links: [
              {
                text: `About ${DOLLAR_BREAKOUT}`,
                href: "https://x/`); evil(); //",
                isNavigation: true,
                selector: { primary: '#l', fallbacks: [], strategy: 'id', confidence: 0.9 },
              },
            ],
          },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const tools = generateSiteTools(site);
      const templateFor = (t: { toolType: string }) =>
        t.toolType === 'page-action' ? 'tool-handler-form.ts' : 'tool-handler-action.ts';
      for (const tool of tools) {
        if (tool.toolType === 'browser-lifecycle') {
          assertParses(renderSiteTemplate('tool-handler-lifecycle.ts', tool), `lifecycle ${tool.name}`);
        } else {
          assertParses(renderSiteTemplate(templateFor(tool), tool), `site ${tool.name}`);
        }
      }
    });
  });

  describe('Python server', () => {
    it('emits a safe URL build (no f-string brace eval) for adversarial path/params/baseUrl', async () => {
      const braceEvalPath = '/things/{id}/{__import__(' + '"os"' + ')}';
      const op = makeOp({
        operationId: 'getThing',
        path: braceEvalPath,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'order-by', in: 'query', required: false, schema: { type: 'string' } },
        ],
      });
      const tool = buildToolDefinition(op);
      const manifest: ProjectManifest = {
        serverName: 'evil-server',
        serverVersion: '1.0.0',
        baseUrl: 'https://api.example.com/"); import os; os.system("boom',
        transport: 'stdio',
        tools: [tool],
        authSchemes: [],
        envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
      };

      const dir = mkdtempSync(join(tmpdir(), 'mcpmake-py-'));
      try {
        await emitPythonProject(manifest, { outputDir: dir, force: true, dryRun: false });
        const py = readFileSync(join(dir, 'server.py'), 'utf-8');

        // The f-string brace-eval form must be gone.
        expect(py).not.toContain('f"{BASE_URL}');
        expect(py).toContain('url = BASE_URL + "');

        // Hyphenated param name becomes a valid Python identifier.
        expect(py).toMatch(/order_by: str = ""/);
        expect(py).not.toMatch(/[(,]\s*order-by/);

        // baseUrl double-quote breakout neutralized (sanitized at emit boundary).
        const baseLine = py.split('\n').find((l) => l.includes('BASE_URL"')) ?? '';
        expect(baseLine).not.toContain('import os');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
