import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { renderTemplate } from '../../src/emitter/template-loader.js';

/** Transpile rendered TS and fail on any syntactic diagnostic (proves it parses). */
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

const httpData = {
  serverName: 'media-gate-api',
  serverVersion: '1.0.0',
  tools: [{ name: 'a' }],
  hasResources: false,
  hasPrompts: false,
  hasOAuth: false,
  hasAsyncTools: false,
};

describe('media-type gate — generated HTTP server rejects non-JSON POST bodies before parse', () => {
  const src = renderTemplate('server-main-http.ts', httpData);

  it('renders parseable TypeScript', () => {
    assertParses(src, 'server-main-http-media-gate');
  });

  it('reads the request Content-Type and rejects non-JSON media with 415', () => {
    expect(src).toContain("headerValue(req.headers['content-type'])");
    // Reject when header absent OR does not declare JSON (mirrors the hosted edge's
    // isJsonMediaType: lowercased substring 'json').
    expect(src).toMatch(/!contentType \|\| !contentType\.toLowerCase\(\)\.includes\('json'\)/);
    expect(src).toMatch(/sendJson\(res, 415, \{/);
    expect(src).toContain('Unsupported Media Type');
  });

  it('runs the media-type guard BEFORE JSON.parse in the POST path', () => {
    const gateIdx = src.indexOf("!contentType.toLowerCase().includes('json')");
    const parseIdx = src.indexOf("JSON.parse(raw.toString('utf-8'))");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(parseIdx).toBeGreaterThan(-1);
    // The 415 guard must short-circuit before the body is ever parsed as JSON, so
    // a mislabeled tools/call body cannot execute.
    expect(gateIdx).toBeLessThan(parseIdx);
  });
});
