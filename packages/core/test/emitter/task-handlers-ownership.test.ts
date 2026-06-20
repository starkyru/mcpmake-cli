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

// The template has no Handlebars expressions, so any data object renders it verbatim.
const src = renderTemplate('task-handlers.ts', {});

describe('L-taskown — task-handlers ownership hardening', () => {
  it('renders parseable TypeScript', () => {
    assertParses(src, 'task-handlers');
  });

  it('gates GET /tasks listing behind MCP_ENABLE_TASK_LIST opt-in (403 otherwise)', () => {
    expect(src).toContain("process.env.MCP_ENABLE_TASK_LIST !== 'true'");
    // The 403 short-circuits before listTasks is reached.
    const guardIdx = src.indexOf('MCP_ENABLE_TASK_LIST');
    const listIdx = src.indexOf('listTasks(statusParam');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(guardIdx);
    expect(src).toMatch(/sendJson\(res, 403, \{[\s\S]*MCP_ENABLE_TASK_LIST/);
  });

  it('rejects JSON-RPC mutation of terminal tasks with -32002', () => {
    expect(src).toContain('TERMINAL_STATUSES');
    expect(src).toMatch(/new Set<string>\(\['completed', 'failed', 'cancelled'\]\)/);
    // tasks/update guards before calling updateTask.
    const updateBlock = src.slice(
      src.indexOf("case 'tasks/update'"),
      src.indexOf("case 'tasks/cancel'"),
    );
    expect(updateBlock).toContain('TERMINAL_STATUSES.has(existing.status)');
    expect(updateBlock).toContain("rpcError(id, -32002, 'Task is in a terminal state')");
    expect(updateBlock.indexOf('TERMINAL_STATUSES.has')).toBeLessThan(
      updateBlock.indexOf('updateTask(taskId'),
    );
  });

  it('rejects JSON-RPC tasks/cancel of terminal tasks with -32002', () => {
    const cancelBlock = src.slice(
      src.indexOf("case 'tasks/cancel'"),
      src.indexOf("case 'tasks/list'"),
    );
    expect(cancelBlock).toContain('TERMINAL_STATUSES.has(existing.status)');
    expect(cancelBlock).toContain("rpcError(id, -32002, 'Task is in a terminal state')");
  });

  it('rejects REST cancel of terminal tasks with 409', () => {
    const restCancel = src.slice(src.indexOf("subPath === '/cancel'"));
    expect(restCancel).toContain('TERMINAL_STATUSES.has(existing.status)');
    expect(restCancel).toMatch(/sendJson\(res, 409, \{ error: 'Task is in a terminal state' \}\)/);
    // Guard precedes the actual cancelTask mutation.
    expect(restCancel.indexOf('TERMINAL_STATUSES.has')).toBeLessThan(
      restCancel.indexOf('cancelTask(taskId)'),
    );
  });

  it('keeps handler signatures unchanged (siblings depend on them)', () => {
    expect(src).toContain('export function handleTaskRpc(');
    expect(src).toContain('export function handleTaskRoutes(');
    expect(src).toMatch(/handleTaskRpc\(\s*method: string,\s*params: unknown,\s*id: unknown,/);
    expect(src).toMatch(
      /handleTaskRoutes\(\s*req: IncomingMessage,\s*res: ServerResponse,\s*url: URL,/,
    );
  });

  it('documents the single-principal trust model', () => {
    expect(src).toMatch(/single shared bearer token/i);
    expect(src).toMatch(/sessions/i);
  });
});
