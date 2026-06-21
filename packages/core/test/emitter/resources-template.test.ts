import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { buildResources } from '../../src/transformer/resource-builder.js';
import { renderTemplate } from '../../src/emitter/template-loader.js';
import type { OperationDescriptor } from '../../src/types/index.js';

/** Transpile rendered TS and fail on any syntactic diagnostic. */
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

function makeOp(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    operationId: 'listItems',
    method: 'get',
    path: '/items',
    tags: ['items'],
    parameters: [],
    responses: [],
    security: [],
    deprecated: false,
    ...overrides,
  };
}

describe('resources.ts template: ResourceTemplate compile-test', () => {
  it('renders valid TS and imports ResourceTemplate for a template resource', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    const src = renderTemplate('resources.ts', { resources });

    // Must parse as valid TS
    assertParses(src, 'template resource');

    // Must use ResourceTemplate constructor, not a bare string
    expect(src).toContain('new ResourceTemplate(');

    // Must NOT use the old positional pathParts approach
    expect(src).not.toContain('pathParts');

    // Must pass variables to the handler callback
    expect(src).toContain('async (uri, variables)');
  });

  it('renders valid TS for a static (non-template) resource without ResourceTemplate', () => {
    const resources = buildResources([makeOp({ operationId: 'listItems', path: '/items' })]);
    const src = renderTemplate('resources.ts', { resources });

    assertParses(src, 'static resource');

    // Static resource must NOT use ResourceTemplate
    expect(src).not.toContain('new ResourceTemplate(');
  });

  it('renders valid TS with both static and template resources', () => {
    const resources = buildResources([
      makeOp({ operationId: 'listItems', path: '/items' }),
      makeOp({
        operationId: 'getItem',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    const src = renderTemplate('resources.ts', { resources });

    assertParses(src, 'mixed resources');

    // Has both static and template registrations
    expect(src).toContain('new ResourceTemplate(');
    expect(src).toContain("'api://list_items'"); // static uses string URI
  });

  it('renders valid TS for multi-param path and substitutes both variables', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getUserPost',
        path: '/v1/users/{userId}/posts/{postId}',
        parameters: [
          { name: 'userId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'postId', in: 'path', required: true, schema: { type: 'string' } },
        ],
      }),
    ]);
    const src = renderTemplate('resources.ts', { resources });

    assertParses(src, 'multi-param template resource');
    expect(src).toContain('new ResourceTemplate(');
    expect(src).toContain("variables['userId']");
    expect(src).toContain("variables['postId']");
  });

  // R16-B: hyphen param name must produce valid TS that still uses new ResourceTemplate().
  // The URI template in the emitted source must contain {user_id} (not {user-id}),
  // and the variables key must match the safe name.
  it('R16-B: renders valid TS for hyphen param — URI template uses underscore, not hyphen', () => {
    const resources = buildResources([
      makeOp({
        operationId: 'getUser',
        path: '/users/{user-id}',
        parameters: [{ name: 'user-id', in: 'path', required: true, schema: { type: 'string' } }],
      }),
    ]);
    const src = renderTemplate('resources.ts', { resources });

    assertParses(src, 'hyphen-param template resource');

    // Must still register as a ResourceTemplate
    expect(src).toContain('new ResourceTemplate(');

    // The ResourceTemplate URI must use the RFC-6570-safe variable name.
    expect(src).toContain("new ResourceTemplate('api://get_user/{user_id}'");

    // Handler must read the safe key, not the raw hyphenated name.
    expect(src).toContain("variables['user_id']");
    expect(src).not.toContain("variables['user-id']");

    // The raw wire token IS still the op.path replace() target (so the literal
    // `{user-id}` legitimately appears here — only the URI-template var is sanitized).
    expect(src).toContain("url.replace('{user-id}'");
  });
});
