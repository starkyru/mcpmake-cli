import { describe, it, expect } from 'vitest';
import {
  buildAgentCard,
  agentCardJson,
  buildA2aModule,
  A2A_PROTOCOL_VERSION,
  A2A_AGENT_CARD_PATH,
  type A2aCardInputs,
} from '../../src/emitter/a2a.js';

describe('a2a generator', () => {
  const inputs: A2aCardInputs = {
    serverName: 'Petstore',
    serverVersion: '2.1.0',
    baseUrl: 'https://api.example.com/v1',
    tools: [
      { name: 'list_pets', title: 'List Pets', description: 'List the pets' },
      { name: 'create_pet', description: 'Create a pet' },
    ],
  };

  it('exposes the published A2A protocol version constant', () => {
    expect(A2A_PROTOCOL_VERSION).toBe('0.3.0');
    expect(A2A_AGENT_CARD_PATH).toBe('/.well-known/agent.json');
  });

  it('builds an AgentCard with the published shape, every value derived from the manifest', () => {
    const card = buildAgentCard(inputs);
    expect(card.name).toBe('Petstore');
    expect(card.version).toBe('2.1.0');
    expect(card.protocolVersion).toBe('0.3.0');
    // url is the A2A JSON-RPC endpoint derived from the base URL (trailing slash collapsed).
    expect(card.url).toBe('https://api.example.com/v1/a2a');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.defaultInputModes).toEqual(['application/json', 'text/plain']);
    expect(card.defaultOutputModes).toEqual(['application/json', 'text/plain']);
    expect(card.provider.organization).toBe('mcpmake');
  });

  it('emits exactly one AgentSkill per tool, with id === tool.name (title falls back to name)', () => {
    const card = buildAgentCard(inputs);
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]).toEqual({
      id: 'list_pets',
      name: 'List Pets', // title preferred
      description: 'List the pets',
      tags: [],
    });
    expect(card.skills[1]).toEqual({
      id: 'create_pet',
      name: 'create_pet', // no title → falls back to name
      description: 'Create a pet',
      tags: [],
    });
    // id is always the tool name (the dispatch key A2A clients reference).
    expect(card.skills.map((s) => s.id)).toEqual(['list_pets', 'create_pet']);
  });

  it('collapses a trailing slash on the base URL when deriving the endpoint', () => {
    const card = buildAgentCard({ ...inputs, baseUrl: 'https://api.example.com/' });
    expect(card.url).toBe('https://api.example.com/a2a');
  });

  it('agentCardJson is the AgentCard as stable pretty JSON', () => {
    expect(agentCardJson(inputs)).toBe(JSON.stringify(buildAgentCard(inputs), null, 2));
  });

  it('buildA2aModule emits a registerA2a module wiring A2A → MCP tools/call via the SDK', () => {
    const mod = buildA2aModule(inputs);
    // Imports the public SDK surface only (server + in-process client + loopback transport).
    expect(mod).toContain("from '@modelcontextprotocol/sdk/server/mcp.js'");
    expect(mod).toContain("from '@modelcontextprotocol/sdk/client/index.js'");
    expect(mod).toContain("from '@modelcontextprotocol/sdk/inMemory.js'");
    // The exported entry point the server template calls.
    expect(mod).toContain('export async function registerA2a(');
    // A2A → tool dispatch goes through the MCP client's public callTool.
    expect(mod).toContain('client.callTool(');
    // The two A2A JSON-RPC transport methods are dispatched.
    expect(mod).toContain("case 'message/send':");
    expect(mod).toContain("case 'tasks/get':");
    // The AgentCard is embedded as a JSON-encoded string constant (inert in source).
    expect(mod).toContain('const AGENT_CARD_JSON = "');
    // Serves the AgentCard at the A2A well-known path.
    expect(mod).toContain('/.well-known/agent.json');
  });

  it('safely encodes a hostile tool description so it cannot break out of the generated source', () => {
    // The generated module is TypeScript: the only breakout from the double-quoted card
    // constant is an unescaped " (or backslash/newline). A backtick / ${} / </script> are
    // inert *data* inside a double-quoted JS string literal, so they need no neutralizing —
    // but a " absolutely does, or it would terminate the literal early.
    const hostileDesc = 'a " quote </script><script>alert(1)</script> ` ${process.env.SECRET}';
    const mod = buildA2aModule({
      serverName: 'x',
      serverVersion: '1.0.0',
      baseUrl: 'https://h.example',
      tools: [{ name: 'evil', description: hostileDesc }],
    });

    // The embedded double-quote must be escaped — a raw `a " quote` would terminate the
    // double-quoted card constant. (Double JSON-encoding renders it as `a \\\" quote`.)
    expect(mod).toContain('a \\\\\\" quote');
    expect(mod).not.toContain('a " quote'); // the unescaped, literal-terminating form must NOT appear

    // Discriminating: recover the embedded AGENT_CARD_JSON literal and parse it back; the
    // description must survive byte-for-byte as inert DATA (proving it never became source).
    const m = mod.match(/const AGENT_CARD_JSON = ("(?:[^"\\]|\\.)*");/);
    expect(m).not.toBeNull();
    const cardJson = JSON.parse(m![1]) as string; // the JS string literal → the card JSON text
    const card = JSON.parse(cardJson) as { skills: { description: string }[] };
    expect(card.skills[0].description).toBe(hostileDesc);
  });

  it('is deterministic (same inputs → byte-identical module across two calls)', () => {
    expect(buildA2aModule(inputs)).toBe(buildA2aModule(inputs));
    expect(agentCardJson(inputs)).toBe(agentCardJson(inputs));
  });
});
