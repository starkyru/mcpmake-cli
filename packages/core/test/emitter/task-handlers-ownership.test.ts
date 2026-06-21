import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import vm from 'node:vm';
import { createRequire } from 'node:module';
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

// ── Live harness ─────────────────────────────────────────────────────────────
// To make assertions behavioral (not source-text greps), we transpile the REAL
// rendered handler to CommonJS and execute it in a sandbox, injecting a mock
// task-manager so we can observe which manager functions the handler actually
// calls. This means a logic inversion in the source (e.g. flipping `!==` to
// `===` on the opt-in guard, or dropping a terminal-state check) makes the
// behavioral tests fail — a comment/source-text-only test would not catch it.

interface RecordedCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  /** Returns a JSON-RPC response object, or null for unrecognized methods. */
  handleTaskRpc(method: string, params: unknown, id: unknown): Record<string, unknown> | null;
  /** Returns true when the request was handled. */
  handleTaskRoutes(req: unknown, res: unknown, url: URL): boolean;
  /** Calls into the mock task-manager, in order. */
  calls: RecordedCall[];
  /** The task `getTask` will return; set per-test. */
  setTask(task: { id: string; status: string } | undefined): void;
  /** What `listTasks` returns. */
  listResult: Array<{ id: string }>;
}

function buildHarness(): Harness {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const calls: RecordedCall[] = [];
  let task: { id: string; status: string } | undefined;
  const listResult: Array<{ id: string }> = [];

  const mockManager = {
    getTask(id: string) {
      calls.push({ fn: 'getTask', args: [id] });
      return task && task.id === id ? task : task; // honor whatever the test set
    },
    listTasks(...args: unknown[]) {
      calls.push({ fn: 'listTasks', args });
      return listResult;
    },
    updateTask(...args: unknown[]) {
      calls.push({ fn: 'updateTask', args });
      return { id: args[0], status: 'working' };
    },
    cancelTask(...args: unknown[]) {
      calls.push({ fn: 'cancelTask', args });
      return { id: args[0], status: 'cancelled' };
    },
    getResult(...args: unknown[]) {
      calls.push({ fn: 'getResult', args });
      return Promise.resolve({ id: 'x', status: 'completed' });
    },
  };

  const realRequire = createRequire(import.meta.url);
  const sandboxedRequire = (spec: string): unknown =>
    spec === './task-manager.js' ? mockManager : realRequire(spec);

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const compiled = vm.compileFunction(js, [
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
  ]);
  compiled(moduleObj.exports, sandboxedRequire, moduleObj, 'task-handlers.js', '/');

  const mod = moduleObj.exports as {
    handleTaskRpc: Harness['handleTaskRpc'];
    handleTaskRoutes: Harness['handleTaskRoutes'];
  };

  return {
    handleTaskRpc: mod.handleTaskRpc,
    handleTaskRoutes: mod.handleTaskRoutes,
    calls,
    listResult,
    setTask(t) {
      task = t;
    },
  };
}

interface CapturedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A minimal ServerResponse stand-in that captures writeHead/end. */
function captureResponse(): { res: unknown; out: CapturedResponse } {
  const out: CapturedResponse = {};
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
    },
    end(body: string) {
      out.body = body === undefined ? undefined : JSON.parse(body);
    },
  };
  return { res, out };
}

function called(calls: RecordedCall[], fn: string): boolean {
  return calls.some((c) => c.fn === fn);
}

describe('L-taskown — task-handlers ownership hardening', () => {
  it('renders parseable TypeScript', () => {
    assertParses(src, 'task-handlers');
  });

  it('exports both handlers with the signatures siblings depend on', () => {
    // Structural: server-main imports these by name + arity; a rename breaks the wire-up.
    const h = buildHarness();
    expect(typeof h.handleTaskRpc).toBe('function');
    expect(typeof h.handleTaskRoutes).toBe('function');
    // handleTaskRpc(method, params, id) — 3 params.
    expect(h.handleTaskRpc.length).toBe(3);
    // handleTaskRoutes(req, res, url) — 3 params.
    expect(h.handleTaskRoutes.length).toBe(3);
  });

  describe('GET /tasks list-all gate (the single-principal trust model)', () => {
    it('refuses to enumerate tasks unless MCP_ENABLE_TASK_LIST opt-in is set (403, listTasks never called)', () => {
      const h = buildHarness();
      delete process.env.MCP_ENABLE_TASK_LIST;
      const { res, out } = captureResponse();

      const handled = h.handleTaskRoutes({ method: 'GET' }, res, new URL('http://x/tasks'));

      expect(handled).toBe(true);
      expect(out.status).toBe(403);
      expect(out.body).toEqual({
        error: 'Task listing is disabled. Set MCP_ENABLE_TASK_LIST=true to enable it.',
      });
      // The guard must short-circuit: enumeration must NOT happen.
      expect(called(h.calls, 'listTasks')).toBe(false);
    });

    it('still refuses when the env var is set to a non-"true" value (exact === check, not truthiness)', () => {
      // Flipping the guard to a truthy test (e.g. `if (process.env.MCP_ENABLE_TASK_LIST)`)
      // would wrongly enable listing for any non-empty value. Assert the exact-match gate.
      for (const value of ['1', 'yes', 'TRUE', 'false']) {
        const h = buildHarness();
        process.env.MCP_ENABLE_TASK_LIST = value;
        const { res, out } = captureResponse();
        h.handleTaskRoutes({ method: 'GET' }, res, new URL('http://x/tasks'));
        expect(out.status, `value=${value}`).toBe(403);
        expect(called(h.calls, 'listTasks'), `value=${value}`).toBe(false);
      }
      delete process.env.MCP_ENABLE_TASK_LIST;
    });

    it('enumerates only when explicitly opted in (200, listTasks IS called)', () => {
      const h = buildHarness();
      process.env.MCP_ENABLE_TASK_LIST = 'true';
      h.listResult.push({ id: 't1' }, { id: 't2' });
      const { res, out } = captureResponse();

      const handled = h.handleTaskRoutes({ method: 'GET' }, res, new URL('http://x/tasks'));
      delete process.env.MCP_ENABLE_TASK_LIST;

      expect(handled).toBe(true);
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ tasks: [{ id: 't1' }, { id: 't2' }] });
      expect(called(h.calls, 'listTasks')).toBe(true);
    });

    it('rejects an unknown status filter with 400 before enumerating', () => {
      const h = buildHarness();
      process.env.MCP_ENABLE_TASK_LIST = 'true';
      const { res, out } = captureResponse();
      h.handleTaskRoutes({ method: 'GET' }, res, new URL('http://x/tasks?status=bogus'));
      delete process.env.MCP_ENABLE_TASK_LIST;

      expect(out.status).toBe(400);
      expect(out.body).toEqual({ error: 'Invalid status filter: bogus' });
      expect(called(h.calls, 'listTasks')).toBe(false);
    });
  });

  describe('R4-E: limit param is parsed through the NaN/zero/over-max guard, default 50', () => {
    // Drive the REAL handler and observe the limit it forwards to listTasks.
    // Each expected value is hand-derived from the spec (default 50, range 1..1000,
    // integer-only via parseInt), independent of the source expression.
    const cases: Array<[query: string, expectedLimit: number, why: string]> = [
      ['', 50, 'no param -> default'],
      ['limit=0', 50, 'zero rejected -> default'],
      ['limit=-5', 50, 'negative rejected -> default'],
      ['limit=abc', 50, 'non-numeric -> default'],
      ['limit=2000', 50, 'over the 1000 cap -> default'],
      ['limit=1001', 50, 'just over the cap -> default'],
      ['limit=10', 10, 'valid value forwarded'],
      ['limit=1', 1, 'lower bound forwarded'],
      ['limit=1000', 1000, 'upper bound forwarded'],
    ];

    for (const [query, expectedLimit, why] of cases) {
      it(`${query || '(no param)'} -> limit ${expectedLimit} (${why})`, () => {
        const h = buildHarness();
        process.env.MCP_ENABLE_TASK_LIST = 'true';
        h.handleTaskRoutes(
          { method: 'GET' },
          captureResponse().res,
          new URL(`http://x/tasks?${query}`),
        );
        delete process.env.MCP_ENABLE_TASK_LIST;

        const listCall = h.calls.find((c) => c.fn === 'listTasks');
        expect(listCall, 'listTasks should be reached when opted in').toBeDefined();
        // listTasks(statusParam, limit) — limit is the 2nd arg.
        expect(listCall!.args[1]).toBe(expectedLimit);
      });
    }
  });

  describe('terminal-task mutation is refused (capability model: outcomes are final)', () => {
    it('JSON-RPC tasks/update of a terminal task returns -32002 and never calls updateTask', () => {
      const h = buildHarness();
      h.setTask({ id: 'a', status: 'completed' });

      const resp = h.handleTaskRpc('tasks/update', { taskId: 'a', status: 'working' }, 7);

      expect(resp).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32002, message: 'Task is in a terminal state' },
      });
      expect(called(h.calls, 'updateTask')).toBe(false);
    });

    it('JSON-RPC tasks/update of a live task IS applied (positive companion)', () => {
      const h = buildHarness();
      h.setTask({ id: 'a', status: 'working' });

      const resp = h.handleTaskRpc(
        'tasks/update',
        { taskId: 'a', status: 'completed', result: { ok: 1 } },
        7,
      );

      expect(called(h.calls, 'updateTask')).toBe(true);
      const updateCall = h.calls.find((c) => c.fn === 'updateTask')!;
      expect(updateCall.args).toEqual([
        'a',
        { status: 'completed', result: { ok: 1 }, error: undefined },
      ]);
      expect(resp).toMatchObject({ jsonrpc: '2.0', id: 7, result: { taskId: 'a' } });
    });

    it('JSON-RPC tasks/cancel of a terminal task returns -32002 and never calls cancelTask', () => {
      const h = buildHarness();
      h.setTask({ id: 'a', status: 'failed' });

      const resp = h.handleTaskRpc('tasks/cancel', { taskId: 'a' }, 7);

      expect(resp).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32002, message: 'Task is in a terminal state' },
      });
      expect(called(h.calls, 'cancelTask')).toBe(false);
    });

    it('JSON-RPC tasks/cancel of a live task IS applied (positive companion)', () => {
      const h = buildHarness();
      h.setTask({ id: 'a', status: 'working' });

      h.handleTaskRpc('tasks/cancel', { taskId: 'a' }, 7);

      expect(called(h.calls, 'cancelTask')).toBe(true);
    });

    it('REST POST /tasks/:id/cancel of a terminal task returns 409 and never calls cancelTask', () => {
      const h = buildHarness();
      h.setTask({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'completed' });
      const { res, out } = captureResponse();

      const handled = h.handleTaskRoutes(
        { method: 'POST' },
        res,
        new URL('http://x/tasks/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cancel'),
      );

      expect(handled).toBe(true);
      expect(out.status).toBe(409);
      expect(out.body).toEqual({ error: 'Task is in a terminal state' });
      expect(called(h.calls, 'cancelTask')).toBe(false);
    });

    it('REST POST /tasks/:id/cancel of a live task IS applied (positive companion, 200)', () => {
      const h = buildHarness();
      h.setTask({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'working' });
      const { res, out } = captureResponse();

      h.handleTaskRoutes(
        { method: 'POST' },
        res,
        new URL('http://x/tasks/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/cancel'),
      );

      expect(out.status).toBe(200);
      expect(called(h.calls, 'cancelTask')).toBe(true);
    });
  });

  describe('JSON-RPC dispatch surface', () => {
    it('tasks/list is removed (cannot be scoped without sessions) -> -32601', () => {
      const h = buildHarness();
      const resp = h.handleTaskRpc('tasks/list', {}, 7);
      expect(resp).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32601,
          message: 'tasks/list is not supported (removed in the Tasks extension)',
        },
      });
    });

    it('an unrecognized method returns null so the caller can forward it', () => {
      const h = buildHarness();
      expect(h.handleTaskRpc('tools/call', {}, 7)).toBeNull();
    });

    it('tasks/get of a missing task returns -32001', () => {
      const h = buildHarness();
      h.setTask(undefined);
      expect(h.handleTaskRpc('tasks/get', { taskId: 'missing' }, 7)).toEqual({
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32001, message: 'Task missing not found' },
      });
    });
  });
});
