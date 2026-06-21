import { describe, it, expect } from 'vitest';
import {
  scaffoldProjectFiles,
  DISCOVERY_RECOMMEND_THRESHOLD,
} from '../../src/emitter/project-scaffolder.js';
import type { ProjectManifest, ToolDefinition } from '../../src/types/index.js';

// Minimal tool objects: the README template only consumes `tools.length`,
// `name`, and `description`, and the scaffolder threshold only reads
// `tools.length`. We cast to ToolDefinition so the manifest is well-typed
// without dragging in the full tool-builder for a count-driven heuristic.
const manyTools = (n: number): ToolDefinition[] =>
  Array.from(
    { length: n },
    (_, i) => ({ name: `tool_${i}`, description: 'desc' }) as unknown as ToolDefinition,
  );

function manifest(over: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    serverName: 'demo',
    serverVersion: '1.0.0',
    baseUrl: 'https://api.example.com',
    transport: 'stdio',
    tools: [],
    authSchemes: [],
    envVars: [{ name: 'BASE_URL', description: 'base', required: false }],
    ...over,
  };
}

/**
 * Drive the REAL scaffolder so the `recommendDiscovery` decision
 * (project-scaffolder.ts:74-75) is actually exercised, then return the
 * generated README contents. Hand-passing the precomputed flag would let a
 * broken threshold pass; routing through scaffoldProjectFiles will not.
 */
function generateReadme(over: Partial<ProjectManifest> = {}): string {
  const units = scaffoldProjectFiles(manifest(over));
  const readme = units.find((u) => u.filePath === 'README.md');
  if (!readme) throw new Error('scaffoldProjectFiles did not emit a README.md');
  return readme.content;
}

const RECOMMEND_TIP = (n: number) => `**Tip — large API (${n} tools).**`;
const DISCOVERY_ENABLED = '**Dynamic discovery is enabled.**';
// The recommendation specifically nudges toward re-running with this flag.
const FLAG = '`--dynamic-discovery`';

describe('generated README: --dynamic-discovery surfacing (real scaffolder threshold)', () => {
  it('threshold is the documented value', () => {
    // Lock the heuristic boundary so a silent threshold change is caught here
    // (the boundary cases below are derived from this exact number).
    expect(DISCOVERY_RECOMMEND_THRESHOLD).toBe(50);
  });

  it('recommends --dynamic-discovery at exactly the threshold (>= boundary)', () => {
    const n = DISCOVERY_RECOMMEND_THRESHOLD;
    const md = generateReadme({ tools: manyTools(n), dynamicDiscovery: false });
    expect(md).toContain(RECOMMEND_TIP(n));
    expect(md).toContain(FLAG);
    // It is a recommendation, not a "discovery already on" notice.
    expect(md).not.toContain(DISCOVERY_ENABLED);
  });

  it('stays quiet one tool below the threshold (off-by-one guard)', () => {
    const n = DISCOVERY_RECOMMEND_THRESHOLD - 1;
    const md = generateReadme({ tools: manyTools(n), dynamicDiscovery: false });
    // No recommendation block and no stray mention of the flag below threshold.
    expect(md).not.toContain(RECOMMEND_TIP(n));
    expect(md).not.toContain('Tip — large API');
    expect(md).not.toContain(FLAG);
    expect(md).not.toContain(DISCOVERY_ENABLED);
  });

  it('recommends well above the threshold and quotes the live tool count', () => {
    const n = DISCOVERY_RECOMMEND_THRESHOLD + 10;
    const md = generateReadme({ tools: manyTools(n), dynamicDiscovery: false });
    // The tip must report the actual tool count, not a hard-coded one.
    expect(md).toContain(RECOMMEND_TIP(n));
    expect(md).not.toContain(RECOMMEND_TIP(DISCOVERY_RECOMMEND_THRESHOLD));
  });

  it('does NOT recommend when discovery is already enabled, even far above threshold', () => {
    const n = DISCOVERY_RECOMMEND_THRESHOLD + 10;
    const md = generateReadme({ tools: manyTools(n), dynamicDiscovery: true });
    // dynamicDiscovery short-circuits the recommendation (the `!dynamicDiscovery`
    // guard); instead the README documents that discovery is on.
    expect(md).not.toContain('Tip — large API');
    expect(md).toContain(DISCOVERY_ENABLED);
    expect(md).toContain(`registering all ${n} tools`);
  });

  it('stays quiet for a small API not using discovery', () => {
    const md = generateReadme({ tools: manyTools(3), dynamicDiscovery: false });
    expect(md).not.toContain('Tip — large API');
    expect(md).not.toContain(FLAG);
    expect(md).not.toContain(DISCOVERY_ENABLED);
  });

  it('defaults to no discovery (dynamicDiscovery undefined) and respects the threshold', () => {
    // dynamicDiscovery omitted -> scaffolder defaults it to false, so a large
    // API still gets the recommendation.
    const n = DISCOVERY_RECOMMEND_THRESHOLD;
    const md = generateReadme({ tools: manyTools(n) });
    expect(md).toContain(RECOMMEND_TIP(n));
    expect(md).not.toContain(DISCOVERY_ENABLED);
  });
});
