/**
 * Fast-tier unit tests for the parity-suite normalizers (test/e2e/helpers/
 * normalize-mcp.ts). The samples below are literal copies of what the REAL
 * generated servers returned over MCP (captured from a built node server and a
 * FastMCP python server against the parity fixture) — and every expected value
 * is hand-written, never computed through the normalizers themselves.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSchema,
  normalizeToolsList,
  normalizeToolCallResult,
  tryParseJson,
} from './e2e/helpers/normalize-mcp.js';

// ── Literal samples ────────────────────────────────────────────────────────

/** list_widgets inputSchema as pydantic/FastMCP emits it (titles, anyOf-null,
 * default:null, identifier-safe X_Request_Id, no param descriptions). */
const PYDANTIC_LIST_WIDGETS = {
  properties: {
    limit: {
      anyOf: [{ maximum: 100, type: 'integer' }, { type: 'null' }],
      default: null,
      title: 'Limit',
    },
    active: { anyOf: [{ type: 'boolean' }, { type: 'null' }], default: null, title: 'Active' },
    sort: {
      anyOf: [{ enum: ['asc', 'desc'], type: 'string' }, { type: 'null' }],
      default: null,
      title: 'Sort',
    },
    X_Request_Id: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      title: 'X Request Id',
    },
  },
  title: 'listWidgetsArguments',
  type: 'object',
};

/** The same tool's inputSchema as zod-to-json-schema emits it ($schema,
 * additionalProperties:false, descriptions, injected control args). */
const ZOD_LIST_WIDGETS = {
  type: 'object',
  properties: {
    limit: {
      type: 'integer',
      maximum: 100,
      description: 'How many widgets to return at one time (max 100)',
    },
    active: { type: 'boolean', description: 'Only return active widgets' },
    sort: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order' },
    'X-Request-Id': { type: 'string', description: 'Optional request correlation id' },
    jq_filter: {
      type: 'string',
      description:
        'Optional jq-style filter applied to the JSON response before it is returned ' +
        '(e.g. ".data", ".items[0].id", ".items[]"). Trims large responses.',
    },
    idempotency_key: {
      type: 'string',
      description:
        'Optional Idempotency-Key header for safe retries of mutating requests. ' +
        'Ignored for read-only operations.',
    },
  },
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
};

/** Hand-written canonical form BOTH of the above must normalize to. */
const CANONICAL_LIST_WIDGETS = {
  type: 'object',
  properties: {
    limit: { maximum: 100, type: 'integer' },
    active: { type: 'boolean' },
    sort: { enum: ['asc', 'desc'], type: 'string' },
    X_Request_Id: { type: 'string' },
  },
};

/** create_widget inputSchema, pydantic-shaped: nested models hoisted into
 * $defs and referenced via $ref (trimmed to the fields that matter). */
const PYDANTIC_CREATE_WIDGET = {
  $defs: {
    CreateWidgetBodyDimensions: {
      properties: {
        width: { anyOf: [{ type: 'number' }, { type: 'null' }], default: null, title: 'Width' },
        height: { anyOf: [{ type: 'number' }, { type: 'null' }], default: null, title: 'Height' },
      },
      title: 'CreateWidgetBodyDimensions',
      type: 'object',
    },
    CreateWidgetBody: {
      properties: {
        name: { description: 'Display name of the widget', title: 'Name', type: 'string' },
        dimensions: {
          anyOf: [{ $ref: '#/$defs/CreateWidgetBodyDimensions' }, { type: 'null' }],
          default: null,
          description: 'Physical size',
        },
      },
      required: ['name'],
      title: 'CreateWidgetBody',
      type: 'object',
    },
  },
  properties: { body: { $ref: '#/$defs/CreateWidgetBody' } },
  required: ['body'],
  title: 'createWidgetArguments',
  type: 'object',
};

/** create_widget inputSchema, zod-shaped: nested inline, control args injected. */
const ZOD_CREATE_WIDGET = {
  type: 'object',
  properties: {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name of the widget' },
        dimensions: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
          additionalProperties: false,
          description: 'Physical size',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    jq_filter: { type: 'string', description: 'Optional jq-style filter…' },
    idempotency_key: { type: 'string', description: 'Optional Idempotency-Key header…' },
  },
  required: ['body'],
  additionalProperties: false,
  $schema: 'http://json-schema.org/draft-07/schema#',
};

const CANONICAL_CREATE_WIDGET = {
  type: 'object',
  properties: {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dimensions: {
          type: 'object',
          properties: { width: { type: 'number' }, height: { type: 'number' } },
        },
      },
      required: ['name'],
    },
  },
  required: ['body'],
};

// ── normalizeSchema ────────────────────────────────────────────────────────

describe('normalizeSchema', () => {
  it('normalizes the pydantic-shaped and zod-shaped list_widgets schemas to the SAME canonical object', () => {
    expect(normalizeSchema(PYDANTIC_LIST_WIDGETS)).toEqual(CANONICAL_LIST_WIDGETS);
    expect(normalizeSchema(ZOD_LIST_WIDGETS)).toEqual(CANONICAL_LIST_WIDGETS);
  });

  it('inlines pydantic $defs/$ref and strips zod control args so nested bodies converge', () => {
    expect(normalizeSchema(PYDANTIC_CREATE_WIDGET)).toEqual(CANONICAL_CREATE_WIDGET);
    expect(normalizeSchema(ZOD_CREATE_WIDGET)).toEqual(CANONICAL_CREATE_WIDGET);
  });

  it('drops jq_filter/idempotency_key from required and removes an emptied required', () => {
    expect(
      normalizeSchema({
        type: 'object',
        properties: { jq_filter: { type: 'string' } },
        required: ['jq_filter'],
      }),
    ).toEqual({ type: 'object', properties: {} });
  });

  it('sorts required and folds kebab-case property names to snake_case', () => {
    expect(
      normalizeSchema({
        type: 'object',
        properties: { 'X-Request-Id': { type: 'string' }, active: { type: 'boolean' } },
        required: ['X-Request-Id', 'active'],
      }),
    ).toEqual({
      type: 'object',
      properties: { X_Request_Id: { type: 'string' }, active: { type: 'boolean' } },
      required: ['X_Request_Id', 'active'],
    });
  });

  it('collapses ONLY 2-element anyOf-with-null; a real union survives', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(normalizeSchema(union)).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
  });
});

// ── normalizeToolsList ─────────────────────────────────────────────────────

describe('normalizeToolsList', () => {
  it('projects to {name, description, inputSchema}, sorted by name, whitespace collapsed', () => {
    const normalized = normalizeToolsList([
      {
        name: 'list_widgets',
        description: '  List   all\nwidgets ',
        inputSchema: ZOD_LIST_WIDGETS,
        title: 'List Widgets', // per-language extra — must NOT survive
        outputSchema: { type: 'object' },
      },
      { name: 'create_widget', description: 'Create a widget', inputSchema: ZOD_CREATE_WIDGET },
    ]);
    expect(normalized).toEqual([
      {
        name: 'create_widget',
        description: 'Create a widget',
        inputSchema: CANONICAL_CREATE_WIDGET,
      },
      {
        name: 'list_widgets',
        description: 'List all widgets',
        inputSchema: CANONICAL_LIST_WIDGETS,
      },
    ]);
  });
});

// ── tryParseJson / normalizeToolCallResult ─────────────────────────────────

describe('tryParseJson', () => {
  it('parses JSON text', () => {
    expect(tryParseJson('{"a": 1}')).toEqual({ a: 1 });
    expect(tryParseJson('[1, 2]')).toEqual([1, 2]);
  });

  it('returns trimmed text when not JSON', () => {
    expect(tryParseJson('  Error: 404 Not Found \n')).toBe('Error: 404 Not Found');
  });

  it('passes undefined through', () => {
    expect(tryParseJson(undefined)).toBeUndefined();
  });
});

describe('normalizeToolCallResult', () => {
  it('parses pretty-printed JSON content so node (2-space) and python (indent=2) converge', () => {
    // node shape (JSON.stringify(result, null, 2)):
    const node = {
      content: [{ type: 'text', text: '[\n  {\n    "id": 1,\n    "name": "anvil"\n  }\n]' }],
    };
    // python shape (json.dumps(data, indent=2) + explicit isError:false):
    const python = {
      isError: false,
      content: [{ type: 'text', text: '[\n  {\n    "id": 1,\n    "name": "anvil"\n  }\n]' }],
    };
    const expected = {
      isError: false,
      content: [{ type: 'text', value: [{ id: 1, name: 'anvil' }] }],
    };
    expect(normalizeToolCallResult(node)).toEqual(expected);
    expect(normalizeToolCallResult(python)).toEqual(expected);
  });

  it('folds isError to a strict boolean (true only when literally true)', () => {
    expect(
      normalizeToolCallResult({
        isError: true,
        content: [{ type: 'text', text: 'Error: 404 Not Found' }],
      }),
    ).toEqual({ isError: true, content: [{ type: 'text', value: 'Error: 404 Not Found' }] });
    expect(normalizeToolCallResult({})).toEqual({ isError: false, content: [] });
  });
});
