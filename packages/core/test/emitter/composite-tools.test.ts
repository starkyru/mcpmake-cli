import { describe, it, expect } from 'vitest';
import {
  parseCompositeToolSpecs,
  validateCompositeTool,
  buildCompositeToolsModule,
  CompositeToolError,
  type CompositeToolSpec,
} from '../../src/emitter/composite-tools.js';
import type { ToolDefinition } from '../../src/types/index.js';

/**
 * Minimal fake tools standing in for two generated tools. The composite builder
 * only reads `name` off each tool, so the rest is filled with inert defaults.
 */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    title: name,
    description: '',
    inputSchemaCode: 'z.object({})',
    operationId: name,
    method: 'get',
    pathTemplate: '/',
    pathParams: [],
    queryParams: [],
    headerParams: [],
    paramMappings: [],
    hasRequestBody: false,
    requestBodyContentType: 'application/json',
    buildHeadersBody: '  return {};',
    operationMeta: '{}',
    fileName: name,
    functionName: name,
    buildUrlBody: "  return baseUrl + '/';",
  };
}

const TOOLS = [fakeTool('create_pet'), fakeTool('show_pet_by_id')];

/** The worked-example composite from the v1 contract. */
const CREATE_AND_SHOW: CompositeToolSpec = {
  name: 'create_and_show_pet',
  description: 'Create a pet, then fetch it back.',
  steps: [
    { tool: 'create_pet', with: { name: { $input: 'petName' } } },
    { tool: 'show_pet_by_id', with: { petId: { $step: [0, 'id'] } } },
  ],
  returns: { $step: [1] },
};

describe('composite-tools: parsing', () => {
  it('parses a well-formed compositeTools list into typed specs', () => {
    const specs = parseCompositeToolSpecs([
      {
        name: 'create_and_show_pet',
        description: 'Create a pet, then fetch it back.',
        steps: [
          { tool: 'create_pet', with: { name: { $input: 'petName' } } },
          { tool: 'show_pet_by_id', with: { petId: { $step: [0, 'id'] } } },
        ],
        returns: { $step: [1] },
      },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('create_and_show_pet');
    expect(specs[0].steps[0].tool).toBe('create_pet');
    expect(specs[0].steps[0].with).toEqual({ name: { $input: 'petName' } });
    expect(specs[0].steps[1].with).toEqual({ petId: { $step: [0, 'id'] } });
    expect(specs[0].returns).toEqual({ $step: [1] });
  });

  it('returns an empty list for absent config (opt-in)', () => {
    expect(parseCompositeToolSpecs(undefined)).toEqual([]);
    expect(parseCompositeToolSpecs(null)).toEqual([]);
  });

  it('rejects a non-list compositeTools value', () => {
    expect(() => parseCompositeToolSpecs({ name: 'x' })).toThrow(CompositeToolError);
  });

  it('rejects a step missing a tool and a composite missing steps', () => {
    expect(() => parseCompositeToolSpecs([{ name: 'c', steps: [{ with: {} }] }])).toThrow(
      /missing a non-empty "tool"/,
    );
    expect(() => parseCompositeToolSpecs([{ name: 'c', steps: [] }])).toThrow(/non-empty "steps"/);
  });

  it('rejects an arg value that is neither literal nor $input/$step', () => {
    expect(() =>
      parseCompositeToolSpecs([
        { name: 'c', steps: [{ tool: 'create_pet', with: { x: { $bogus: 1 } } }] },
      ]),
    ).toThrow(/must be a literal/);
  });
});

describe('composite-tools: validation derives inputSchema names', () => {
  it('derives the distinct $input names referenced across all steps (sorted)', () => {
    const spec: CompositeToolSpec = {
      name: 'multi_input',
      steps: [
        { tool: 'create_pet', with: { name: { $input: 'petName' }, tag: { $input: 'tag' } } },
        { tool: 'show_pet_by_id', with: { petId: { $input: 'petName' } } }, // reused → not duplicated
      ],
    };
    const { inputNames } = validateCompositeTool(spec, new Set(['create_pet', 'show_pet_by_id']));
    expect(inputNames).toEqual(['petName', 'tag']);
  });

  it('the worked example derives exactly the one $input it references', () => {
    const { inputNames } = validateCompositeTool(
      CREATE_AND_SHOW,
      new Set(['create_pet', 'show_pet_by_id']),
    );
    expect(inputNames).toEqual(['petName']);
  });
});

describe('composite-tools: validation rejects bad references', () => {
  const names = new Set(['create_pet', 'show_pet_by_id']);

  it('rejects a step naming a tool that does not exist', () => {
    const spec: CompositeToolSpec = {
      name: 'c',
      steps: [{ tool: 'no_such_tool', with: {} }],
    };
    expect(() => validateCompositeTool(spec, names)).toThrow(/unknown tool "no_such_tool"/);
  });

  it('rejects a forward $step reference (a step referencing itself or a later step)', () => {
    const forward: CompositeToolSpec = {
      name: 'c',
      steps: [
        { tool: 'create_pet', with: { x: { $step: [1, 'id'] } } }, // step 0 → step 1 (forward)
        { tool: 'show_pet_by_id', with: {} },
      ],
    };
    expect(() => validateCompositeTool(forward, names)).toThrow(/only reference an EARLIER step/);

    const selfRef: CompositeToolSpec = {
      name: 'c',
      steps: [{ tool: 'create_pet', with: { x: { $step: [0] } } }], // step 0 → step 0
    };
    expect(() => validateCompositeTool(selfRef, names)).toThrow(/only reference an EARLIER step/);
  });

  it('rejects a returns reference to a non-existent step', () => {
    const spec: CompositeToolSpec = {
      name: 'c',
      steps: [{ tool: 'create_pet', with: {} }],
      returns: { $step: [5] },
    };
    expect(() => validateCompositeTool(spec, names)).toThrow(/"returns" references step 5/);
  });

  it('rejects a composite whose name collides with an existing tool', () => {
    const spec: CompositeToolSpec = { name: 'create_pet', steps: [{ tool: 'create_pet' }] };
    expect(() => validateCompositeTool(spec, names)).toThrow(/collides with an existing/);
  });
});

describe('composite-tools: emitted module', () => {
  it('emits a synchronous registerCompositeTools wiring the SDK loopback client', () => {
    const mod = buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS);
    // Imports the SDK pieces the loopback dispatch needs (compiles against the SDK).
    expect(mod).toContain("from '@modelcontextprotocol/sdk/server/mcp.js'");
    expect(mod).toContain("from '@modelcontextprotocol/sdk/client/index.js'");
    expect(mod).toContain("from '@modelcontextprotocol/sdk/inMemory.js'");
    expect(mod).toContain(
      'export function registerCompositeTools(\n  server: McpServer,\n  registerTools: (s: McpServer) => void,\n): void',
    );
    // Registers the composite under its declared name with its description.
    expect(mod).toContain('server.registerTool(\n    "create_and_show_pet"');
    expect(mod).toContain('"Create a pet, then fetch it back."');
  });

  it('resolves $input to the composite input object and $step to the steps array', () => {
    const mod = buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS);
    // Step 0 invokes create_pet with name = the composite's own "petName" input.
    expect(mod).toContain(
      'steps[0] = await callStep(client, "create_pet", {\n        "name": input["petName"],\n      });',
    );
    // Step 1 invokes show_pet_by_id with petId = field "id" of step 0's result.
    expect(mod).toContain(
      'steps[1] = await callStep(client, "show_pet_by_id", {\n        "petId": stepField(steps, 0, "id"),\n      });',
    );
    // returns: { $step: [1] } → the whole result of step 1.
    expect(mod).toContain('const result = steps[1];');
  });

  it('emits a z.string() input field per derived $input name', () => {
    const mod = buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS);
    expect(mod).toContain('"petName": z.string()');
  });

  it('defaults returns to the last step when no returns is declared', () => {
    const spec: CompositeToolSpec = {
      name: 'c',
      steps: [
        { tool: 'create_pet', with: {} },
        { tool: 'show_pet_by_id', with: {} },
      ],
    };
    const mod = buildCompositeToolsModule([spec], TOOLS);
    expect(mod).toContain('const result = steps[1];'); // last step index
  });

  it('emits a stepField helper that throws on a missing field / non-object result', () => {
    const mod = buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS);
    expect(mod).toContain(
      'function stepField(steps: unknown[], i: number, field: string): unknown',
    );
    expect(mod).toContain('its result is not a JSON object');
    expect(mod).toContain('has no field');
  });

  it('throws at build time on a duplicate composite name', () => {
    expect(() => buildCompositeToolsModule([CREATE_AND_SHOW, CREATE_AND_SHOW], TOOLS)).toThrow(
      /Duplicate composite tool name/,
    );
  });

  it('safely encodes a hostile tool/input/field name (no breakout from the literal)', () => {
    const hostile: CompositeToolSpec = {
      name: 'evil',
      steps: [
        {
          tool: 'create_pet',
          with: {
            // A hostile $input name with a quote + injection attempt.
            arg: { $input: 'x"); process.exit(1); //' },
          },
        },
      ],
    };
    const mod = buildCompositeToolsModule([hostile], TOOLS);
    // The raw injection must NOT appear unescaped as executable source — it only
    // ever appears inside a JSON.stringify'd string literal (key lookup), so the
    // double-quote is backslash-escaped and the payload is inert.
    expect(mod).not.toContain('); process.exit(1); //]');
    expect(mod).toContain('input["x\\"); process.exit(1); //"]');
    // The derived input field name is likewise a JSON-encoded (inert) key.
    expect(mod).toContain('"x\\"); process.exit(1); //": z.string()');
  });

  it('is deterministic (same inputs → byte-identical module)', () => {
    expect(buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS)).toBe(
      buildCompositeToolsModule([CREATE_AND_SHOW], TOOLS),
    );
  });
});
