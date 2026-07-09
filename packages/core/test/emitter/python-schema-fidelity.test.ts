/**
 * A4-H2 — the generated Python (FastMCP) server must expose FULL-FIDELITY input
 * schemas. FastMCP infers each tool's inputSchema from the handler function
 * SIGNATURE, so this suite asserts the emitted `server.py` carries precise
 * per-parameter Python annotations (types / enums / bounds / required / default)
 * plus a Pydantic model for a plain-object request body — instead of the prior
 * all-`str` signature that collapsed every param to an optional string.
 *
 * Assertions are string-level against the rendered source (no tautology: the
 * fixture schemas are hand-written and the expectations are independently
 * derived from the A4-H2 spec, not computed via the emitter). When `python3` is
 * on PATH, the rendered file is additionally `py_compile`d so a malformed
 * annotation fails loudly rather than silently shipping.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildToolDefinition } from '../../src/transformer/tool-builder.js';
import { emitPythonProject } from '../../src/emitter/index.js';
import type { OperationDescriptor, ProjectManifest } from '../../src/types/index.js';

/** A rich operation exercising every annotation path in one tool. */
function richOp(): OperationDescriptor {
  return {
    operationId: 'searchWidgets',
    method: 'post',
    path: '/orgs/{orgId}/widgets',
    summary: 'Search widgets',
    tags: [],
    parameters: [
      // required string path param
      {
        name: 'orgId',
        in: 'path',
        required: true,
        description: 'Org id',
        schema: { type: 'string', minLength: 1 },
      },
      // optional integer query param with min/max
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100 },
      },
      // required string-enum query param
      {
        name: 'status',
        in: 'query',
        required: true,
        schema: { type: 'string', enum: ['active', 'archived'] },
      },
      // boolean
      { name: 'includeDeleted', in: 'query', required: false, schema: { type: 'boolean' } },
      // array param
      {
        name: 'tags',
        in: 'query',
        required: false,
        schema: { type: 'array', items: { type: 'string' } },
      },
    ],
    requestBody: {
      required: true,
      description: 'Widget to create',
      contentType: 'application/json',
      schema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 80 },
          price: { type: 'number', minimum: 0 },
          // non-identifier wire key — must be aliased
          'unit-label': { type: 'string' },
        },
      },
    },
    responses: [],
    security: [],
    deprecated: false,
  };
}

function manifestWith(op: OperationDescriptor): ProjectManifest {
  return {
    serverName: 'widget-api',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'stdio',
    tools: [buildToolDefinition(op)],
    authSchemes: [],
    envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
  };
}

/** Render server.py for a manifest into a fresh temp dir; return source + dir. */
async function emitPy(manifest: ProjectManifest): Promise<{ py: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mcpmake-fidelity-'));
  await emitPythonProject(manifest, { outputDir: dir, force: true, dryRun: false });
  const py = readFileSync(join(dir, 'server.py'), 'utf-8');
  return { py, dir };
}

/** True when a `python3` interpreter is available for the optional compile gate. */
function pythonAvailable(): string | undefined {
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

describe('A4-H2 — full-fidelity Python input schema', () => {
  it('emits precise per-param annotations and a Pydantic body model', async () => {
    const { py, dir } = await emitPy(manifestWith(richOp()));
    try {
      // --- imports the precise annotations depend on ---
      expect(py).toContain('from typing import Annotated, Literal, Optional, Any');
      expect(py).toContain('from pydantic import BaseModel, Field, ConfigDict');

      const defLine = py.split('\n').find((l) => l.includes('async def searchWidgets('));
      expect(defLine, 'tool def line present').toBeTruthy();

      // --- required path param: bare `str`, NO default, NO `| None` ---
      // (the `(?![ |])` guards against matching the optional `str | None` form).
      expect(defLine!).toMatch(/orgId: Annotated\[str, Field\(min_length=1\)\]/);
      expect(defLine!).not.toMatch(/orgId:[^,)]*= None/);

      // --- required string-enum query param → Literal[...] with NO default ---
      expect(defLine!).toMatch(/status: Literal\["active", "archived"\]/);
      expect(defLine!).not.toMatch(/status:[^,)]*= None/);

      // --- optional integer query param → int with ge/le, `| None = None` ---
      expect(defLine!).toMatch(/limit: Annotated\[int \| None, Field\(ge=1, le=100\)\] = None/);

      // --- boolean optional ---
      expect(defLine!).toMatch(/includeDeleted: bool \| None = None/);

      // --- array param → list[str] ---
      expect(defLine!).toMatch(/tags: list\[str\] \| None = None/);

      // --- required params precede optional params (Python ordering rule) ---
      const idxOrgId = defLine!.indexOf('orgId:');
      const idxStatus = defLine!.indexOf('status:');
      const idxBody = defLine!.indexOf('body:');
      const idxLimit = defLine!.indexOf('limit:');
      expect(idxOrgId).toBeGreaterThanOrEqual(0);
      expect(idxLimit).toBeGreaterThan(idxOrgId);
      expect(idxLimit).toBeGreaterThan(idxStatus);
      expect(idxLimit).toBeGreaterThan(idxBody);

      // --- request body → a Pydantic BaseModel, typed as the model (required) ---
      expect(py).toMatch(/class \w*Body\w*\(BaseModel\):/);
      expect(defLine!).toMatch(/body: \w+Body/); // model type, not `dict`
      expect(defLine!).not.toContain('body: dict');

      // required body field has no `| None`; optional body fields do.
      expect(py).toMatch(/\n {4}name: str = Field\(max_length=80\)/);
      expect(py).toMatch(/price: float \| None = Field\(default=None, ge=0\)/);

      // --- non-identifier wire key aliased + populate_by_name on the model ---
      expect(py).toContain('model_config = ConfigDict(populate_by_name=True)');
      expect(py).toMatch(/unit_label: str \| None = Field\(alias="unit-label", default=None\)/);

      // --- body serialized by_alias so the wire key is restored on the request ---
      expect(py).toContain('body.model_dump(exclude_none=True, by_alias=True)');

      // --- optional query filtering keeps falsy values (None-only drop) ---
      expect(py).toContain('if v is not None');
      expect(py).not.toContain('if v}'); // the old truthy filter is gone

      // --- optional compile gate (skips cleanly when no interpreter) ---
      const bin = pythonAvailable();
      if (bin) {
        // py_compile must succeed — a syntactically invalid annotation throws.
        expect(() =>
          execFileSync(bin, ['-m', 'py_compile', join(dir, 'server.py')], { stdio: 'pipe' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits Pydantic-legal field names for digit/underscore/keyword body keys (no leading `_`)', async () => {
    // Regression: Pydantic v2 raises `NameError: Fields must not use names with
    // leading underscores` for a model field named `_foo`. A digit-leading wire
    // key (`2fa_token`) sanitized with the generic `_`-prefix rule, and an
    // underscore-leading wire key (`_internal`), both used to crash the server at
    // import. The Pydantic field name must start with a letter (here `f_`), with
    // the ORIGINAL wire key preserved via Field(alias=...).
    const op = richOp();
    op.operationId = 'edgeKeys';
    op.path = '/things';
    op.parameters = [];
    op.requestBody = {
      required: true,
      contentType: 'application/json',
      schema: {
        type: 'object',
        required: ['2fa_token', 'name'],
        properties: {
          '2fa_token': { type: 'string' },
          _internal: { type: 'string' },
          class: { type: 'string' }, // python keyword
          'user-id': { type: 'string' },
          name: { type: 'string' },
        },
      },
    };
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      // No model FIELD name may begin with `_` (the colon disambiguates a field
      // line `    name: type` from arbitrary text).
      const fieldLines = py.split('\n').filter((l) => /^ {4}[A-Za-z_]\w*\s*:/.test(l));
      for (const line of fieldLines) {
        const fname = line.trim().split(/\s*:/)[0];
        expect(fname.startsWith('_'), `field "${fname}" must not start with "_"`).toBe(false);
      }
      // Digit-leading + underscore-leading + keyword keys are remapped to a
      // letter-leading field, each aliased back to the exact wire key.
      expect(py).toContain('f_2fa_token: str = Field(alias="2fa_token")');
      expect(py).toContain('Field(alias="_internal"');
      expect(py).toContain('class_:'); // keyword → trailing underscore
      expect(py).toContain('Field(alias="class"');
      expect(py).toContain('user_id: str | None = Field(alias="user-id"');
      // populate_by_name is required so the aliased model accepts either name.
      expect(py).toContain('model_config = ConfigDict(populate_by_name=True)');

      // The decisive check: Pydantic must accept the model at import time.
      const bin = pythonAvailable();
      if (bin) {
        expect(() =>
          execFileSync(bin, ['-m', 'py_compile', join(dir, 'server.py')], { stdio: 'pipe' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remaps Pydantic-reserved `model_*` body keys so the server still imports', async () => {
    // Regression: Pydantic v2 reserves the `model_` namespace — `model_config`
    // is the special ConfigDict class attribute and `model_dump`/`model_validate`/
    // `model_fields` are BaseModel members. Such wire keys (common in ML/AI specs)
    // are valid Python identifiers and slip past the keyword check, but using them
    // as field names raises at class-definition time → dead-on-import server. They
    // must be remapped to `f_`-prefixed fields aliased to the original wire key.
    const op = richOp();
    op.operationId = 'infer';
    op.path = '/infer';
    op.parameters = [];
    op.requestBody = {
      required: true,
      contentType: 'application/json',
      schema: {
        type: 'object',
        required: ['model_config', 'name'],
        properties: {
          model_config: { type: 'object', properties: { temp: { type: 'number' } } },
          model_dump: { type: 'string' },
          model_validate: { type: 'string' },
          name: { type: 'string' },
        },
      },
    };
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      // No field name may live in the `model_` protected namespace.
      const fieldLines = py.split('\n').filter((l) => /^ {4}[A-Za-z_]\w*\s*:/.test(l));
      for (const line of fieldLines) {
        const fname = line.trim().split(/\s*:/)[0];
        expect(
          fname.startsWith('model_'),
          `field "${fname}" must not be in the model_ namespace`,
        ).toBe(false);
      }
      expect(py).toContain('f_model_config: ');
      expect(py).toContain('Field(alias="model_config")');
      expect(py).toContain('f_model_dump: str | None = Field(alias="model_dump"');
      const bin = pythonAvailable();
      if (bin) {
        expect(() =>
          execFileSync(bin, ['-m', 'py_compile', join(dir, 'server.py')], { stdio: 'pipe' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keyword operationId emits a keyword-safe `async def` while keeping the wire tool name', async () => {
    // Regression: a one-word Python-keyword operationId (`class`, `return`,
    // `import`, …) was emitted verbatim as `async def class(...)` → SyntaxError,
    // a dead-on-import server. The def identifier must be suffixed (`class_`),
    // but the MCP-visible @server.tool(name="…") must stay the original wire name.
    const op = richOp();
    op.operationId = 'class';
    op.path = '/things';
    op.parameters = [];
    op.requestBody = undefined;
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      expect(py).toContain('async def class_('); // keyword-safe def identifier
      expect(py).not.toMatch(/async def class\(/); // never the bare keyword
      expect(py).toContain('@server.tool(name="class")'); // wire name preserved
      const bin = pythonAvailable();
      if (bin) {
        expect(() =>
          execFileSync(bin, ['-m', 'py_compile', join(dir, 'server.py')], { stdio: 'pipe' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves array request-body type and optionality', async () => {
    const op = richOp();
    op.operationId = 'bulkUpload';
    op.requestBody = {
      required: false,
      contentType: 'application/json',
      schema: { type: 'array', items: { type: 'string' } },
    };
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      const defLine = py.split('\n').find((l) => l.includes('async def bulkUpload('));
      expect(defLine, 'tool def line present').toBeTruthy();
      expect(defLine!).toContain('body: list[str] | None = None');
      // No model_dump for the fallback path (raw dict passed straight through).
      expect(py).not.toContain('body.model_dump');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves requiredness and type for scalar request bodies', async () => {
    const op = richOp();
    op.operationId = 'setEnabled';
    op.parameters = [];
    op.requestBody = {
      required: true,
      description: 'Whether the feature is enabled',
      contentType: 'application/json',
      schema: { type: 'boolean' },
    };
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      const defLine = py.split('\n').find((l) => l.includes('async def setEnabled('));
      expect(defLine, 'tool def line present').toBeTruthy();
      expect(defLine!).toContain(
        'body: Annotated[bool, Field(description="Whether the feature is enabled")]',
      );
      expect(defLine!).not.toContain('body: dict');
      expect(defLine!).not.toMatch(/body:[^,)]*= None/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops regex patterns pydantic-core cannot compile, keeps safe ones (corpus: asana)', async () => {
    // pydantic-core uses the Rust `regex` crate: no backreferences, no
    // lookarounds. Emitting such a pattern kills the server at import time
    // with a SchemaError, so the constraint must be dropped — while an
    // ordinary pattern must still be emitted.
    const op = richOp();
    op.operationId = 'patternedOp';
    op.requestBody = undefined;
    op.parameters = [
      {
        name: 'opt_fields',
        in: 'query',
        required: false,
        // asana's comma-separated-enum idiom: backreference `\1`.
        schema: { type: 'string', pattern: '([a-z]+)(,\\1)*' },
      },
      {
        name: 'peek',
        in: 'query',
        required: false,
        schema: { type: 'string', pattern: '(?=abc).*' },
      },
      {
        name: 'plain',
        in: 'query',
        required: false,
        schema: { type: 'string', pattern: '^[a-z]+$' },
      },
    ];
    const { py, dir } = await emitPy(manifestWith(op));
    try {
      const defLine = py.split('\n').find((l) => l.includes('async def patternedOp('));
      expect(defLine, 'tool def line present').toBeTruthy();
      // Unsafe patterns dropped entirely — plain `str | None`, no Field(pattern=…).
      expect(defLine!).toMatch(/opt_fields: str \| None = None/);
      expect(defLine!).toMatch(/peek: str \| None = None/);
      // Safe pattern preserved.
      expect(defLine!).toMatch(/plain: Annotated\[str \| None, Field\(pattern="\^\[a-z\]\+\$"\)\] = None/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
