/**
 * Composite tools (`compositeTools:` in `.mcpmake.yaml`): one MCP tool that
 * orchestrates several EXISTING generated tools in sequence, threading data
 * between them. Opt-in — absent config emits nothing.
 *
 * A composite is declared as an ordered list of steps. Each step names an
 * existing generated tool (by its MCP tool name) and an argument map (`with`)
 * whose values are either:
 *   • a literal (string / number / boolean),
 *   • `{ $input: <name> }` — a value the composite tool takes as its OWN input,
 *   • `{ $step: [i] }`      — the whole JSON result of an earlier step i, or
 *   • `{ $step: [i, field] }` — a top-level `field` of an earlier step i's result.
 * The composite's `returns` (default: the last step) selects which step result
 * is returned. The composite's inputSchema is the set of distinct `$input` names
 * referenced across every step — each a `z.string()` for v1 (documented limit).
 *
 * The generated handler runs the steps IN ORDER. It invokes each step's
 * underlying request by calling that step's existing generated tool through an
 * in-process MCP loopback client (InMemoryTransport + Client.callTool) — the
 * SAME public-SDK pattern `a2a.ts` uses. This reuses each tool's real request
 * logic verbatim (method, path template, param mapping, auth, jq filtering); no
 * HTTP is reinvented here. Each step's parsed JSON result is stored so later
 * steps and `returns` can reference it.
 *
 * PURE: a deterministic function of the inputs. Every interpolated value (tool
 * names, input names, field names, literals) is JSON.stringify'd into the
 * generated source, so no character from the (untrusted) config can break out of
 * a string literal. No Date.now()/random — identical input → byte-identical output.
 */

import type { ToolDefinition } from '../types/index.js';

/** A literal value usable directly as a step argument. */
export type CompositeLiteral = string | number | boolean;

/** A reference to one of the composite tool's own inputs. */
export interface CompositeInputRef {
  $input: string;
}

/**
 * A reference to a prior step's result. `[i]` is the whole result of step i;
 * `[i, field]` is the top-level `field` of step i's result.
 */
export interface CompositeStepRef {
  $step: [number] | [number, string];
}

/** A resolved value for a step argument or the composite's `returns`. */
export type CompositeValue = CompositeLiteral | CompositeInputRef | CompositeStepRef;

/** One step of a composite tool: invoke `tool` with the resolved `with` map. */
export interface CompositeStepSpec {
  /** The MCP tool name of an EXISTING generated tool to invoke. */
  tool: string;
  /** Argument-name → value map for this step's tool call. */
  with?: Record<string, CompositeValue>;
}

/** A composite-tool declaration (one entry under `compositeTools:`). */
export interface CompositeToolSpec {
  name: string;
  description?: string;
  steps: CompositeStepSpec[];
  /** Which step's result the composite returns. Default: the last step. */
  returns?: CompositeStepRef;
}

/** Thrown when a composite-tool declaration is invalid (surfaced at build time). */
export class CompositeToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeToolError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInputRef(v: unknown): v is CompositeInputRef {
  return isPlainObject(v) && typeof (v as { $input?: unknown }).$input === 'string';
}

function isStepRef(v: unknown): v is CompositeStepRef {
  if (!isPlainObject(v)) return false;
  const ref = (v as { $step?: unknown }).$step;
  if (!Array.isArray(ref) || ref.length < 1 || ref.length > 2) return false;
  if (typeof ref[0] !== 'number' || !Number.isInteger(ref[0])) return false;
  if (ref.length === 2 && typeof ref[1] !== 'string') return false;
  return true;
}

function isLiteral(v: unknown): v is CompositeLiteral {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Parse + validate the raw `compositeTools` value from `.mcpmake.yaml` into typed
 * specs. Throws a {@link CompositeToolError} (clear, build-time) on any malformed
 * entry. Loosely-typed input (the YAML loader returns `unknown`) is checked here.
 */
export function parseCompositeToolSpecs(raw: unknown): CompositeToolSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CompositeToolError('compositeTools must be a list of composite-tool declarations');
  }
  return raw.map((entry, idx) => parseOne(entry, idx));
}

function parseOne(entry: unknown, idx: number): CompositeToolSpec {
  const where = `compositeTools[${idx}]`;
  if (!isPlainObject(entry)) {
    throw new CompositeToolError(`${where} must be a mapping`);
  }
  const name = entry.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new CompositeToolError(`${where} is missing a non-empty "name"`);
  }
  const description = typeof entry.description === 'string' ? entry.description : undefined;

  const rawSteps = entry.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new CompositeToolError(`Composite tool "${name}" must declare a non-empty "steps" list`);
  }
  const steps: CompositeStepSpec[] = rawSteps.map((s, sIdx) => {
    if (!isPlainObject(s)) {
      throw new CompositeToolError(`Composite tool "${name}" step ${sIdx} must be a mapping`);
    }
    if (typeof s.tool !== 'string' || !s.tool.trim()) {
      throw new CompositeToolError(
        `Composite tool "${name}" step ${sIdx} is missing a non-empty "tool"`,
      );
    }
    let withMap: Record<string, CompositeValue> | undefined;
    if (s.with !== undefined) {
      if (!isPlainObject(s.with)) {
        throw new CompositeToolError(
          `Composite tool "${name}" step ${sIdx} "with" must be a mapping`,
        );
      }
      withMap = {};
      for (const [argName, value] of Object.entries(s.with)) {
        withMap[argName] = parseValue(value, name, sIdx, argName);
      }
    }
    return { tool: s.tool, with: withMap };
  });

  let returns: CompositeStepRef | undefined;
  if (entry.returns !== undefined) {
    if (!isStepRef(entry.returns)) {
      throw new CompositeToolError(
        `Composite tool "${name}" "returns" must be a { $step: [i] } / { $step: [i, field] } reference`,
      );
    }
    returns = entry.returns;
  }

  return { name, description, steps, returns };
}

function parseValue(
  value: unknown,
  toolName: string,
  stepIdx: number,
  argName: string,
): CompositeValue {
  if (isLiteral(value)) return value;
  if (isInputRef(value)) {
    if (!value.$input.trim()) {
      throw new CompositeToolError(
        `Composite tool "${toolName}" step ${stepIdx} arg "${argName}": $input name must be non-empty`,
      );
    }
    return value;
  }
  if (isStepRef(value)) return value;
  throw new CompositeToolError(
    `Composite tool "${toolName}" step ${stepIdx} arg "${argName}" must be a literal, ` +
      `{ $input: <name> }, or { $step: [i] } / { $step: [i, field] }`,
  );
}

export interface CompositeBuildResult {
  /** The distinct `$input` names referenced across all steps (inputSchema keys), sorted. */
  inputNames: string[];
}

/**
 * Validate a single composite spec against the set of existing tool names and
 * derive its build result (the `$input` names that form its inputSchema). Throws
 * a {@link CompositeToolError} on any invalid reference. Validation rules:
 *   • every step's `tool` must be an existing generated tool name;
 *   • a `$step: [i]` may reference only an EARLIER step (i < current step index)
 *     and a valid step index (0 ≤ i);
 *   • `returns` must reference a valid step index (0 ≤ i < steps.length);
 *   • the composite name must not collide with an existing tool name.
 */
export function validateCompositeTool(
  spec: CompositeToolSpec,
  existingToolNames: ReadonlySet<string>,
): CompositeBuildResult {
  if (existingToolNames.has(spec.name)) {
    throw new CompositeToolError(
      `Composite tool "${spec.name}" collides with an existing generated tool of the same name`,
    );
  }

  const inputNames = new Set<string>();
  spec.steps.forEach((step, stepIdx) => {
    if (!existingToolNames.has(step.tool)) {
      throw new CompositeToolError(
        `Composite tool "${spec.name}" step ${stepIdx} references unknown tool "${step.tool}". ` +
          `It must name an existing generated tool.`,
      );
    }
    for (const [argName, value] of Object.entries(step.with ?? {})) {
      if (isInputRef(value)) {
        inputNames.add(value.$input);
      } else if (isStepRef(value)) {
        const target = value.$step[0];
        if (target < 0 || target >= stepIdx) {
          throw new CompositeToolError(
            `Composite tool "${spec.name}" step ${stepIdx} arg "${argName}" references step ${target}, ` +
              `but a step may only reference an EARLIER step (0..${stepIdx - 1}).`,
          );
        }
      }
    }
  });

  const returnsTarget = spec.returns ? spec.returns.$step[0] : spec.steps.length - 1;
  if (returnsTarget < 0 || returnsTarget >= spec.steps.length) {
    throw new CompositeToolError(
      `Composite tool "${spec.name}" "returns" references step ${returnsTarget}, ` +
        `but valid steps are 0..${spec.steps.length - 1}.`,
    );
  }

  return { inputNames: [...inputNames].sort() };
}

/**
 * Emit the runtime expression that resolves one composite {@link CompositeValue}
 * at handler runtime. Literals and refs are JSON.stringify'd so no config text
 * can break out of the generated source. `$step` references read from the
 * `steps` result array; `[i, field]` calls a runtime helper that throws a clear
 * error when the result is not an object or the field is missing.
 */
function emitValueExpr(value: CompositeValue): string {
  if (isInputRef(value)) {
    // Read from the composite tool's own input object.
    return `input[${JSON.stringify(value.$input)}]`;
  }
  if (isStepRef(value)) {
    const [i, field] = value.$step;
    if (field === undefined) {
      return `steps[${JSON.stringify(i)}]`;
    }
    return `stepField(steps, ${JSON.stringify(i)}, ${JSON.stringify(field)})`;
  }
  // Literal: JSON-encode (covers string/number/boolean inertly).
  return JSON.stringify(value);
}

/** Emit the `arguments` object literal for one step's tool call. */
function emitArgsObject(withMap: Record<string, CompositeValue> | undefined): string {
  const entries = Object.entries(withMap ?? {});
  if (entries.length === 0) return '{}';
  const lines = entries.map(
    ([argName, value]) => `        ${JSON.stringify(argName)}: ${emitValueExpr(value)},`,
  );
  return `{\n${lines.join('\n')}\n      }`;
}

/** Emit the JS for one step inside the handler's sequential run loop. */
function emitStep(step: CompositeStepSpec, stepIdx: number): string {
  return (
    `      // Step ${stepIdx}: ${'invoke an existing generated tool'}\n` +
    `      steps[${stepIdx}] = await callStep(client, ${JSON.stringify(step.tool)}, ${emitArgsObject(step.with)});`
  );
}

/** Emit the registration for one composite tool (its inputSchema + handler). */
function emitCompositeRegistration(spec: CompositeToolSpec, build: CompositeBuildResult): string {
  const schemaFields =
    build.inputNames.length === 0
      ? '{}'
      : `{\n${build.inputNames
          .map(
            (n) =>
              `      ${JSON.stringify(n)}: z.string().describe('Input "${escapeForLineComment(n)}" for composite tool ${escapeForLineComment(spec.name)}'),`,
          )
          .join('\n')}\n    }`;

  const stepsBody = spec.steps.map((s, i) => emitStep(s, i)).join('\n');
  const returnsTarget = spec.returns ? spec.returns.$step[0] : spec.steps.length - 1;
  const returnsField =
    spec.returns && spec.returns.$step.length === 2 ? spec.returns.$step[1] : undefined;
  const returnExpr =
    returnsField === undefined
      ? `steps[${JSON.stringify(returnsTarget)}]`
      : `stepField(steps, ${JSON.stringify(returnsTarget)}, ${JSON.stringify(returnsField)})`;

  return `  server.registerTool(
    ${JSON.stringify(spec.name)},
    {
      title: ${JSON.stringify(spec.name)},
      description: ${JSON.stringify(spec.description ?? `Composite tool: runs ${spec.steps.length} step(s) in order.`)},
      inputSchema: ${schemaFields},
    },
    async (rawInput) => {
      const input = rawInput as Record<string, unknown>;
      const steps: unknown[] = [];
      try {
        const client = await getClient(registerTools);
${stepsBody}
        const result = ${returnExpr};
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: \`Error: \${message}\` }],
          isError: true,
        };
      }
    },
  );`;
}

/**
 * Escape a string for safe inclusion inside a single-quoted JS string that is
 * itself emitted as part of a `.describe('...')` call. Strips quotes/backslashes/
 * newlines so an input/tool name from config can never break the literal.
 */
function escapeForLineComment(s: string): string {
  return s.replace(/[\\'\r\n]/g, '');
}

/**
 * Build the `src/composite-tools.ts` module that registers every composite tool.
 * Validates each spec against the existing tool names first (throws a
 * {@link CompositeToolError} on any invalid reference). Returns the module
 * source.
 *
 * The handler dispatches each step through an in-process MCP loopback client
 * (the same `InMemoryTransport` + `Client.callTool` pattern as `a2a.ts`), so the
 * step's real generated request logic runs — no HTTP is reinvented. The
 * `registerTools` callback (passed by the server entry) populates the dedicated
 * loopback server with the same tool surface the primary server exposes.
 */
export function buildCompositeToolsModule(
  specs: readonly CompositeToolSpec[],
  tools: readonly ToolDefinition[],
): string {
  const existingToolNames = new Set(tools.map((t) => t.name));

  // Reject a composite whose name duplicates another composite, too — they are
  // all registered on the same server and a dup would crash registration.
  const seenComposite = new Set<string>();
  const registrations = specs.map((spec) => {
    if (seenComposite.has(spec.name)) {
      throw new CompositeToolError(`Duplicate composite tool name "${spec.name}"`);
    }
    seenComposite.add(spec.name);
    const build = validateCompositeTool(spec, existingToolNames);
    return emitCompositeRegistration(spec, build);
  });

  return `import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/* Composite tools: each runs several EXISTING generated tools in order, threading
 * data between them. Steps are dispatched through an in-process MCP loopback
 * client connected to a DEDICATED server populated with the same tool surface, so
 * each step reuses that tool's real request logic (method, path, params, auth, jq
 * filtering). Generated by @mcpmake/core — do not edit by hand. */

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/* Parse a step tool's CallToolResult into a plain JS value for later steps and
 * the composite's return. Prefers structuredContent (the SDK validates it against
 * the tool's outputSchema); otherwise parses the first text block as JSON, falling
 * back to the raw text. A tool that reported isError fails the whole composite. */
function parseStepResult(result: ToolResult): unknown {
  if ((result as { isError?: unknown }).isError === true) {
    const content = (result as { content?: unknown }).content;
    const text =
      Array.isArray(content) && content[0] && typeof content[0] === 'object'
        ? String((content[0] as { text?: unknown }).text ?? '')
        : 'step tool reported an error';
    throw new Error(text);
  }
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (structured !== undefined) return structured;
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = String((block as { text?: unknown }).text ?? '');
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
    }
  }
  return undefined;
}

/* Resolve a { $step: [i, field] } reference: read \`field\` off step i's result.
 * Throws a clear error when the result is not an object or the field is missing,
 * so the composite tool call fails with a useful message. */
function stepField(steps: unknown[], i: number, field: string): unknown {
  const r = steps[i];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    throw new Error(
      \`Cannot read field "\${field}" from step \${i}: its result is not a JSON object\`,
    );
  }
  if (!(field in (r as Record<string, unknown>))) {
    throw new Error(\`Step \${i} result has no field "\${field}"\`);
  }
  return (r as Record<string, unknown>)[field];
}

/* Invoke one step's existing generated tool via the loopback client and return
 * its parsed result. \`args\` values come from the composite's own input or an
 * earlier step's result. */
async function callStep(
  client: Client,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Strip args whose resolved value is undefined (an absent optional input) so the
  // step tool sees only the arguments actually supplied.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) clean[k] = v;
  }
  const result = await client.callTool({ name: toolName, arguments: clean });
  return parseStepResult(result);
}

/* Lazily stand up (once) the DEDICATED loopback McpServer + in-process MCP client
 * that composite steps dispatch through. \`registerTools\` populates the loopback
 * server with the same tool surface the primary server exposes, so each step
 * reuses that tool's real request logic. Memoized: the first composite call
 * connects the pair; subsequent calls reuse it. Public SDK API only. */
let clientPromise: Promise<Client> | undefined;
function getClient(registerTools: (s: McpServer) => void): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { McpServer: McpServerCtor } = await import(
        '@modelcontextprotocol/sdk/server/mcp.js'
      );
      const loopback = new McpServerCtor({ name: 'composite-loopback', version: '0.0.0' });
      registerTools(loopback);
      const client = new Client({ name: 'composite-loopback-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await loopback.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    })();
  }
  return clientPromise;
}

/**
 * Register every composite tool on \`server\`. \`registerTools\` populates the
 * dedicated loopback server (lazily, on the first composite call) with the same
 * tool surface the primary server exposes, so a composite step never contends
 * with the primary transport.
 */
export function registerCompositeTools(
  server: McpServer,
  registerTools: (s: McpServer) => void,
): void {
${registrations.join('\n\n')}
}
`;
}
