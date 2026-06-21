import { defineCommand } from 'citty';
import { writeFile } from 'node:fs/promises';
import { stringify as yamlStringify } from 'yaml';
import { loadOpenApiSpec } from '@mcpmake/core';
import { logger } from '@mcpmake/core';
import type { OpenAPIV3 } from 'openapi-types';

export default defineCommand({
  meta: {
    name: 'merge',
    description: 'Merge two OpenAPI specs into one',
  },
  args: {
    spec1: {
      type: 'positional',
      description: 'Path to the first OpenAPI spec (used as base for info/servers)',
      required: true,
    },
    spec2: {
      type: 'positional',
      description: 'Path to the second OpenAPI spec to merge in',
      required: true,
    },
    output: {
      type: 'string',
      alias: 'o',
      description: 'Output file path (default: stdout)',
    },
  },
  async run({ args }) {
    logger.info(`Merging specs: ${args.spec1} + ${args.spec2}`);

    const { api: api1 } = await loadOpenApiSpec(args.spec1);
    const { api: api2 } = await loadOpenApiSpec(args.spec2);

    const spec1 = api1 as OpenAPIV3.Document;
    const spec2 = api2 as OpenAPIV3.Document;

    const merged = mergeSpecs(spec1, spec2);

    const output = yamlStringify(merged, { lineWidth: 120 });

    if (args.output) {
      await writeFile(args.output, output, 'utf-8');
      logger.success(`Merged spec written to: ${args.output}`);
    } else {
      process.stdout.write(output);
    }
  },
});

/**
 * Merge two path-level parameter arrays, deduplicating by (name, in).
 * On a tie the base entry wins (first occurrence in the seen set is kept).
 * Exported so tests can exercise the real production logic directly.
 */
export function mergePathItemParameters(
  baseParams: OpenAPIV3.ParameterObject[],
  otherParams: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  const seen = new Set<string>();
  const result: OpenAPIV3.ParameterObject[] = [];
  for (const p of [...baseParams, ...otherParams]) {
    const key = `${p.name}\0${p.in}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

export function mergeSpecs(
  base: OpenAPIV3.Document,
  other: OpenAPIV3.Document,
): OpenAPIV3.Document {
  const merged: OpenAPIV3.Document = {
    openapi: base.openapi ?? '3.0.0',
    info: base.info,
    servers: base.servers,
    paths: { ...base.paths },
    components: {
      schemas: {},
      securitySchemes: {},
      ...(base.components ?? {}),
    },
  };

  // Merge paths
  const basePaths = base.paths ?? {};
  const otherPaths = other.paths ?? {};

  for (const [path, pathItem] of Object.entries(otherPaths)) {
    if (basePaths[path]) {
      // Check for method-level conflicts
      const baseItem = basePaths[path] as OpenAPIV3.PathItemObject | null;
      const otherItem = pathItem as OpenAPIV3.PathItemObject | null;

      // Either path item may be null in a malformed but otherwise parseable spec.
      // In that case keep whichever side is non-null (or drop the path if both are).
      if (!baseItem || !otherItem) {
        const kept = otherItem ?? baseItem;
        if (kept) merged.paths[path] = kept;
        continue;
      }

      const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

      for (const method of methods) {
        if (baseItem[method] && otherItem[method]) {
          throw new Error(`Path conflict: ${method.toUpperCase()} ${path} exists in both specs`);
        }
      }

      // No method conflicts — merge path items.
      // Spread operations from both sides; then fix up path-level parameters so
      // that baseItem.parameters is not silently overwritten by otherItem.parameters.
      const mergedItem: OpenAPIV3.PathItemObject = { ...baseItem, ...otherItem };

      if (baseItem.parameters || otherItem.parameters) {
        const baseParams = (baseItem.parameters ?? []) as OpenAPIV3.ParameterObject[];
        const otherParams = (otherItem.parameters ?? []) as OpenAPIV3.ParameterObject[];
        mergedItem.parameters = mergePathItemParameters(baseParams, otherParams);
      }

      merged.paths[path] = mergedItem;
    } else {
      merged.paths[path] = pathItem;
    }
  }

  // Merge components.schemas
  const baseSchemas = base.components?.schemas ?? {};
  const otherSchemas = other.components?.schemas ?? {};

  for (const [name, schema] of Object.entries(otherSchemas)) {
    if (baseSchemas[name]) {
      throw new Error(`Schema conflict: "${name}" exists in both specs`);
    }
    merged.components!.schemas![name] = schema;
  }

  // Merge components.securitySchemes
  const baseSecSchemes = base.components?.securitySchemes ?? {};
  const otherSecSchemes = other.components?.securitySchemes ?? {};

  for (const [name, scheme] of Object.entries(otherSecSchemes)) {
    if (baseSecSchemes[name]) {
      // If both have the same security scheme name, check if they're identical
      const baseScheme = JSON.stringify(baseSecSchemes[name]);
      const otherScheme = JSON.stringify(scheme);
      if (baseScheme !== otherScheme) {
        throw new Error(`Security scheme conflict: "${name}" differs between specs`);
      }
      // Same scheme — skip silently
    } else {
      merged.components!.securitySchemes![name] = scheme;
    }
  }

  // Merge other component types if present
  const componentTypes = [
    'parameters',
    'requestBodies',
    'responses',
    'headers',
    'examples',
    'links',
    'callbacks',
  ] as const;

  for (const compType of componentTypes) {
    const baseComp = (base.components as Record<string, Record<string, unknown>> | undefined)?.[
      compType
    ];
    const otherComp = (other.components as Record<string, Record<string, unknown>> | undefined)?.[
      compType
    ];
    if (otherComp) {
      if (!baseComp) {
        (merged.components as Record<string, unknown>)[compType] = { ...otherComp };
      } else {
        for (const [name, value] of Object.entries(otherComp)) {
          if (baseComp[name]) {
            throw new Error(`Component conflict in ${compType}: "${name}" exists in both specs`);
          }
          (merged.components as Record<string, Record<string, unknown>>)[compType][name] = value;
        }
      }
    }
  }

  // Merge tags (deduplicate by name)
  if (base.tags || other.tags) {
    const tagMap = new Map<string, OpenAPIV3.TagObject>();
    for (const tag of base.tags ?? []) {
      tagMap.set(tag.name, tag);
    }
    for (const tag of other.tags ?? []) {
      if (!tagMap.has(tag.name)) {
        tagMap.set(tag.name, tag);
      }
    }
    merged.tags = [...tagMap.values()];
  }

  // Merge top-level security (union)
  if (base.security || other.security) {
    const seen = new Set<string>();
    const mergedSecurity: OpenAPIV3.SecurityRequirementObject[] = [];
    for (const req of [...(base.security ?? []), ...(other.security ?? [])]) {
      const key = JSON.stringify(req);
      if (!seen.has(key)) {
        seen.add(key);
        mergedSecurity.push(req);
      }
    }
    merged.security = mergedSecurity;
  }

  const pathCount = Object.keys(merged.paths).length;
  const schemaCount = Object.keys(merged.components?.schemas ?? {}).length;
  logger.info(`Merged result: ${pathCount} paths, ${schemaCount} schemas`);

  return merged;
}
