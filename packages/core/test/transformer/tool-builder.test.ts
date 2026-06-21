import { describe, it, expect, vi } from 'vitest';
import { buildToolDefinition, buildAllTools } from '../../src/transformer/tool-builder.js';
import type { OperationDescriptor } from '../../src/types/index.js';
import * as loggerModule from '../../src/utils/logger.js';

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

describe('tool-builder', () => {
  describe('buildToolDefinition', () => {
    it('generates correct tool name and title', () => {
      const tool = buildToolDefinition(makeOp());
      expect(tool.name).toBe('list_pets');
      expect(tool.title).toBe('List Pets');
    });

    it('uses summary as description', () => {
      const tool = buildToolDefinition(makeOp({ summary: 'List all pets' }));
      expect(tool.description).toBe('List all pets');
    });

    it('marks deprecated operations', () => {
      const tool = buildToolDefinition(makeOp({ summary: 'Old endpoint', deprecated: true }));
      expect(tool.description).toContain('[DEPRECATED]');
    });

    it('extracts path and query params', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'showPetById',
          path: '/pets/{petId}',
          parameters: [
            { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
          ],
        }),
      );
      expect(tool.pathParams).toEqual(['petId']);
      expect(tool.queryParams).toEqual(['fields']);
    });

    it('keeps bodyInputKey and schema body key in lock-step when "body" and "requestBody" params exist (R11-D)', () => {
      // The schema emits "requestBody_2" for the body; the tool's bodyInputKey
      // must be that same key so the handler reads from the right input slot.
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'edgeCase',
          method: 'post',
          path: '/edge',
          parameters: [
            { name: 'body', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'requestBody', in: 'query', required: false, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            contentType: 'application/json',
            schema: { type: 'object', properties: { x: { type: 'number' } } },
          },
        }),
      );

      // The handler must look up the body under the same key the schema emits.
      expect(tool.bodyInputKey).toBe('requestBody_2');
      expect(tool.inputSchemaCode).toContain('"requestBody_2":');

      // The two named params must keep their original keys.
      expect(tool.inputSchemaCode).toContain('"body":');
      expect(tool.inputSchemaCode).toContain('"requestBody":');

      // Three distinct keys total — no duplicate in the source string.
      expect((tool.inputSchemaCode.match(/"body":/g) ?? []).length).toBe(1);
      expect((tool.inputSchemaCode.match(/"requestBody":/g) ?? []).length).toBe(1);
      expect((tool.inputSchemaCode.match(/"requestBody_2":/g) ?? []).length).toBe(1);
    });

    it('detects request body', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'createPet',
          method: 'post',
          requestBody: {
            required: true,
            contentType: 'application/json',
            schema: { type: 'object' },
          },
        }),
      );
      expect(tool.hasRequestBody).toBe(true);
      expect(tool.requestBodyContentType).toBe('application/json');
    });

    it('generates buildUrlBody with path params', () => {
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'showPetById',
          path: '/pets/{petId}',
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      );
      expect(tool.buildUrlBody).toContain("replace('{petId}'");
      expect(tool.buildUrlBody).toContain('encodeURIComponent');
    });

    it('generates buildUrlBody with query params', () => {
      const tool = buildToolDefinition(
        makeOp({
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
        }),
      );
      expect(tool.buildUrlBody).toContain('URLSearchParams');
      expect(tool.buildUrlBody).toContain("'limit'");
    });

    it('R16-A: path param with dots uses raw wire name as replace target, not sanitized form', () => {
      // A param whose wireName contains a dot (e.g. `user.id`) must produce a
      // replace('{user.id}', …) call, NOT replace('{userid}', …).  The URL kept
      // by sanitizePathTemplate preserves the dot, so only the raw token matches.
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'getUserById',
          path: '/users/{user.id}',
          parameters: [{ name: 'user.id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      );
      // Raw wire name token is present as the replace target
      expect(tool.buildUrlBody).toContain("replace('{user.id}'");
      // Sanitized (dot-stripped) form must NOT appear as the replace target
      expect(tool.buildUrlBody).not.toContain("replace('{userid}'");
      expect(tool.buildUrlBody).toContain('encodeURIComponent');
    });

    it('R17-A: path param with space strips to match sanitized URL token', () => {
      // sanitizePathTemplate strips chars outside [a-zA-Z0-9/{}._-] globally, so
      // a path `/v1/{user id}/x` becomes `/v1/{userid}/x` in the URL string.
      // The replace target must be `{userid}` (not `{user id}`) or the brace token
      // is never replaced and gets sent upstream literally.
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'getUserSection',
          path: '/v1/{user id}/x',
          parameters: [{ name: 'user id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      );
      // Token in URL is {userid} (space stripped by sanitizePathTemplate)
      expect(tool.buildUrlBody).toContain("replace('{userid}'");
      // Raw form with space must NOT appear — it would never match the URL token
      expect(tool.buildUrlBody).not.toContain("replace('{user id}'");
      // Value is still read from inputKey (mapped from the original 'user id' name)
      expect(tool.buildUrlBody).toContain('"user id"');
      expect(tool.buildUrlBody).toContain('encodeURIComponent');
    });

    it('R17-A: R16-A dot case is unaffected (dot is in keep-set)', () => {
      // tokenName === wireName when wireName contains only kept chars [a-zA-Z0-9._-],
      // so the R16-A fix for dot-separated names must continue to work unchanged.
      const tool = buildToolDefinition(
        makeOp({
          operationId: 'getUserById',
          path: '/users/{user.id}',
          parameters: [{ name: 'user.id', in: 'path', required: true, schema: { type: 'string' } }],
        }),
      );
      expect(tool.buildUrlBody).toContain("replace('{user.id}'");
      expect(tool.buildUrlBody).not.toContain("replace('{userid}'");
    });
  });

  describe('buildAllTools', () => {
    it('handles name collisions by appending method', () => {
      const ops = [
        makeOp({ operationId: 'pets', method: 'get', path: '/pets' }),
        makeOp({ operationId: 'pets', method: 'post', path: '/pets' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools[0].name).toBe('pets_get');
      expect(tools[1].name).toBe('pets_post');
    });

    it('preserves unique names', () => {
      const ops = [
        makeOp({ operationId: 'listPets' }),
        makeOp({ operationId: 'createPet', method: 'post' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools[0].name).toBe('list_pets');
      expect(tools[1].name).toBe('create_pet');
    });

    it('disambiguates operations sharing operationId AND method (M14)', () => {
      // Same operationId + same method: appending the method does not separate
      // them, so without a second-pass dedup the later tool silently overwrites
      // the first's name and output file. Both must survive distinctly.
      const ops = [
        makeOp({ operationId: 'pets', method: 'get', path: '/pets' }),
        makeOp({ operationId: 'pets', method: 'get', path: '/v2/pets' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      const fileNames = tools.map((t) => t.fileName);
      expect(new Set(names).size).toBe(2);
      expect(new Set(fileNames).size).toBe(2);
      // First keeps the stable name; the collision gets a numeric suffix.
      expect(names[0]).toBe('pets_get');
      expect(names[1]).toBe('pets_get_2');
      expect(fileNames[1]).not.toBe(fileNames[0]);
    });

    it('disambiguates three-way operationId AND method collisions (M14)', () => {
      const ops = [
        makeOp({ operationId: 'pets', method: 'get', path: '/a' }),
        makeOp({ operationId: 'pets', method: 'get', path: '/b' }),
        makeOp({ operationId: 'pets', method: 'get', path: '/c' }),
      ];
      const tools = buildAllTools(ops);
      expect(new Set(tools.map((t) => t.name)).size).toBe(3);
      expect(new Set(tools.map((t) => t.fileName)).size).toBe(3);
      expect(new Set(tools.map((t) => t.functionName)).size).toBe(3);
    });

    it('R16-C: operation whose name slugs to a reserved discovery meta-tool name gets a _2 suffix', () => {
      // In hybrid mode, `execute_tool`, `list_tools`, `get_tool_schema`, and
      // `search_tools` are registered as meta-tools.  A static operation whose
      // toToolName result collides must receive a numeric suffix so the server
      // does not attempt a duplicate registerTool() call at startup.
      const ops = [
        // operationId "executeTool" → toToolName → "execute_tool" — reserved
        makeOp({ operationId: 'executeTool', method: 'post', path: '/execute' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools).toHaveLength(1);
      // Must NOT keep the reserved name
      expect(tools[0].name).not.toBe('execute_tool');
      // Must be the next available suffixed name
      expect(tools[0].name).toBe('execute_tool_2');
    });

    it('R19-B: two tools whose names share their first 128 chars get distinct names after truncation', () => {
      // If two operationIds produce names that differ only beyond position 128, the
      // dedup pass (second pass) leaves them both as-is (they ARE distinct strings).
      // Without the R19-B fix the subsequent truncation collapses them to the same
      // 128-char prefix, causing duplicate server.registerTool() calls at startup.
      // The suffix appended by the dedup pass itself is short (<5 chars), so we
      // craft raw names via x-mcp-name rather than relying on operationId slugging.
      //
      // Strategy: supply two ops whose mcpExtensions.name values are identical in
      // their first 128 chars but differ at position 128+. After buildAllTools the
      // returned names must both be ≤128 chars AND globally distinct.
      // Both names are 130 chars. They share their first 128 chars (128 'a's) and
      // differ only at positions 129-130. The dedup pass sees two distinct strings
      // and leaves them both unchanged. The truncation pass then slices both to the
      // same 128-char prefix ('a'.repeat(128)) — without the R19-B fix they collide.
      const sharedPrefix = 'a'.repeat(128); // exactly 128 'a' chars
      const ops = [
        makeOp({
          operationId: 'opA',
          method: 'get',
          path: '/a',
          mcpExtensions: { name: `${sharedPrefix}xx` }, // 130 chars, differs at 129-130
        }),
        makeOp({
          operationId: 'opB',
          method: 'get',
          path: '/b',
          mcpExtensions: { name: `${sharedPrefix}yy` }, // 130 chars, same first 128
        }),
      ];
      const tools = buildAllTools(ops);
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      // Both names must be within the 128-char MCP limit
      for (const n of names) {
        expect(n.length).toBeLessThanOrEqual(128);
      }
      // Names must be globally distinct — no duplicate registerTool() collision
      expect(new Set(names).size).toBe(2);
    });

    it('R19-B: short names (≤128 chars) are unchanged by the truncation pass', () => {
      // The common case: names well under the limit must not acquire any suffix.
      const ops = [
        makeOp({ operationId: 'listPets', method: 'get', path: '/pets' }),
        makeOp({ operationId: 'createPet', method: 'post', path: '/pets' }),
      ];
      const tools = buildAllTools(ops);
      expect(tools[0].name).toBe('list_pets');
      expect(tools[1].name).toBe('create_pet');
    });

    it('skips an operation with an unsupported body media type and returns the others (R10-A)', () => {
      // One XML body operation among two valid JSON ones.  Without the per-op
      // try/catch, bodyEncodingFor throws for application/xml and aborts ALL
      // three tools.  With the fix, exactly two tools come back and a warn is
      // emitted naming the skipped operation.
      const warnSpy = vi.spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});
      try {
        const ops = [
          makeOp({ operationId: 'listPets', method: 'get', path: '/pets' }),
          makeOp({
            operationId: 'uploadXml',
            method: 'post',
            path: '/upload',
            requestBody: {
              required: true,
              contentType: 'application/xml',
              schema: { type: 'object' },
            },
          }),
          makeOp({ operationId: 'createPet', method: 'post', path: '/pets' }),
        ];
        const tools = buildAllTools(ops);

        // Two valid tools survive; the XML one is skipped.
        expect(tools).toHaveLength(2);
        expect(tools.map((t) => t.operationId)).not.toContain('uploadXml');
        expect(tools.map((t) => t.operationId)).toContain('listPets');
        expect(tools.map((t) => t.operationId)).toContain('createPet');

        // A warning was logged naming the skipped operation.
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toContain('uploadXml');
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
