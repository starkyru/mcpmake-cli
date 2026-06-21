import type { ProjectManifest } from '../types/index.js';
import type { SiteProjectManifest, SiteToolDefinition } from '../types/site.js';
import type { CodeUnit } from './code-writer.js';
import { writeCodeUnits } from './code-writer.js';
import {
  scaffoldProjectFiles,
  scaffoldSharedModules,
  escapeDotenvValue,
} from './project-scaffolder.js';
import { scaffoldSiteProjectFiles, scaffoldSiteSharedModules } from './site-scaffolder.js';
import { renderTemplate } from './template-loader.js';
import { renderSiteTemplate } from './site-template-loader.js';
import { renderPythonTemplate } from './python-template-loader.js';
import { renderWorkerTemplate } from './worker-template-loader.js';
import { buildCatalog } from '../transformer/catalog-builder.js';
import { logger } from '../utils/logger.js';
import { sanitizeUrlLiteral, sanitizePyIdentifier } from '../utils/sanitize.js';
import type { ToolDefinition } from '../types/index.js';
import {
  jsonSchemaToPyAnnotation,
  renderParamAnnotation,
  isModellableObject,
  buildPydanticModel,
  ModelNameAllocator,
  isPyKeyword,
  type PydanticModel,
} from './python-annotations.js';

export interface EmitOptions {
  outputDir: string;
  force: boolean;
  dryRun: boolean;
  /**
   * Prune orphaned generated tool files (`src/tools/*.ts`) that are no longer in
   * the emitted set — used by in-place regeneration (`rescan --write`) so removed
   * forms/pages/operations don't leave stale, still-compiled files behind (M12).
   * Off by default: a fresh emit has nothing to prune and must never delete
   * pre-existing user files.
   */
  prune?: boolean;
}

const SAFE_VERSION_RE = /^[0-9a-zA-Z._+-]{1,50}$/;

/**
 * Whether any configured auth scheme sends the API key as a query parameter.
 * Query-string API-key auth cannot be applied as a header, so the generated
 * tool handler appends it during URL construction instead (D-H2). Used to gate
 * the `apiKeyQueryName` config field and the handler's append logic so projects
 * without query auth are byte-for-byte unchanged.
 */
function hasQueryApiKey(manifest: ProjectManifest): boolean {
  return manifest.authSchemes.some((s) => s.type === 'apiKey' && s.in === 'query');
}

/**
 * Per-tool render data for the handler templates. Carries the manifest-level
 * `hasQueryApiKey` flag onto each tool so the template can emit the query
 * API-key append without needing access to the whole manifest.
 */
function toToolHandlerView(
  tool: ToolDefinition,
  manifest: ProjectManifest,
): Record<string, unknown> {
  return { ...tool, hasQueryApiKey: hasQueryApiKey(manifest) };
}

/**
 * Serialize named environments for the generated `.env.example` / `.dev.vars`
 * seed (the `MCP_ENVIRONMENTS` JSON map). Returns undefined when none are set,
 * so the templates keep their commented placeholder for normal output.
 */
function environmentsJson(manifest: ProjectManifest): string | undefined {
  return manifest.environments && Object.keys(manifest.environments).length > 0
    ? JSON.stringify(manifest.environments)
    : undefined;
}

export async function emitProject(manifest: ProjectManifest, options: EmitOptions): Promise<void> {
  // Cloudflare Workers target uses a separate (stateless Fetch-handler) pipeline.
  if (manifest.target === 'cloudflare') {
    return emitWorkerProject(manifest, options);
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.serverName)) {
    throw new Error(
      `Invalid server name: "${manifest.serverName}". Must match /^[a-z0-9][a-z0-9._-]*$/`,
    );
  }

  // baseUrl is emitted into string literals across TS/Python/TOML/.env targets.
  // Sanitize once here so a malicious spec/flag value cannot break out of any of
  // them (lossless for real URLs).
  manifest = { ...manifest, baseUrl: sanitizeUrlLiteral(manifest.baseUrl) };

  if (!SAFE_VERSION_RE.test(manifest.serverVersion)) {
    logger.warn(`Unsafe server version "${manifest.serverVersion}" sanitized to "0.0.0"`);
    manifest = { ...manifest, serverVersion: '0.0.0' };
  }

  const units: CodeUnit[] = [];

  // Project skeleton
  units.push(...scaffoldProjectFiles(manifest));

  // Shared source modules
  units.push(...scaffoldSharedModules(manifest));

  // Task manager (if any async operations detected)
  const hasAsyncTools = manifest.tools.some((t) => t.isAsync);
  if (hasAsyncTools) {
    units.push({
      filePath: 'src/task-manager.ts',
      content: renderTemplate('task-manager.ts', manifest),
    });
    units.push({
      filePath: 'src/task-handlers.ts',
      content: renderTemplate('task-handlers.ts', manifest),
    });
    units.push({
      filePath: 'src/task-sse.ts',
      content: renderTemplate('task-sse.ts', manifest),
    });
  }

  // OAuth module (if OAuth2 auth detected)
  const hasOAuth = manifest.authSchemes.some((s) => s.type === 'oauth2');
  if (hasOAuth) {
    units.push({
      filePath: 'src/oauth.ts',
      content: renderTemplate('oauth.ts', manifest),
    });
  }

  if (manifest.dynamicDiscovery) {
    // Dynamic discovery mode: emit catalog + discovery meta-tools
    const catalog = buildCatalog(manifest.tools);
    units.push({
      filePath: 'src/tool-catalog.json',
      content: JSON.stringify(catalog, null, 2),
    });
    units.push({
      filePath: 'src/discovery.ts',
      content: renderTemplate('discovery.ts', manifest),
    });

    // Hybrid mode: also register first N tools statically
    const staticCount = manifest.staticToolCount ?? 0;
    const staticTools = manifest.tools.slice(0, staticCount);

    if (staticTools.length > 0) {
      for (const tool of staticTools) {
        units.push({
          filePath: `src/tools/${tool.fileName}.ts`,
          content: renderTemplate('tool-handler.ts', toToolHandlerView(tool, manifest)),
        });
      }
      units.push({
        filePath: 'src/tools/index.ts',
        content: renderTemplate('tool-index.ts', { tools: staticTools }),
      });
    }

    logger.info(
      `Dynamic discovery: ${catalog.length} tools in catalog` +
        (staticTools.length > 0 ? `, ${staticTools.length} static` : ''),
    );
  } else {
    // Standard mode: emit all tools individually
    for (const tool of manifest.tools) {
      units.push({
        filePath: `src/tools/${tool.fileName}.ts`,
        content: renderTemplate('tool-handler.ts', toToolHandlerView(tool, manifest)),
      });
    }

    units.push({
      filePath: 'src/tools/index.ts',
      content: renderTemplate('tool-index.ts', { tools: manifest.tools }),
    });
  }

  // Resources file (if any GET list endpoints exist)
  if (manifest.resources && manifest.resources.length > 0) {
    units.push({
      filePath: 'src/resources.ts',
      content: renderTemplate('resources.ts', { resources: manifest.resources }),
    });
  }

  // Prompts file (if any)
  if (manifest.prompts && manifest.prompts.length > 0) {
    units.push({
      filePath: 'src/prompts.ts',
      content: renderTemplate('prompts.ts', { prompts: manifest.prompts }),
    });
  }

  // Test files for each tool
  for (const tool of manifest.tools) {
    units.push({
      filePath: `test/tools/${tool.fileName}.test.ts`,
      content: renderTemplate('tool-test.ts', tool),
    });
  }

  logger.info(`Writing ${units.length} files to ${options.outputDir}`);
  await writeCodeUnits(units, options.outputDir, options);
}

/**
 * Emit a Cloudflare Workers MCP server project (the `--target cloudflare` path).
 *
 * Workers is stateless and has no node:http server, so the SDK's
 * StreamableHTTPServerTransport cannot run there. The entry (`src/index.ts`) is a
 * hand-rolled JSON-RPC Fetch handler instead. The runtime-agnostic modules
 * (`http.ts`, `auth.ts`, `trace.ts`) are reused verbatim from the Node templates —
 * they only need `nodejs_compat`, which `wrangler.toml` enables.
 *
 * v1 scope is tools + initialize/ping/server-discover + bearer auth. Resources,
 * prompts, the Tasks extension and OAuth2 outbound auth are not emitted for this
 * target (a warning is logged and the user is pointed at `--target node`).
 */
export async function emitWorkerProject(
  manifest: ProjectManifest,
  options: EmitOptions,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.serverName)) {
    throw new Error(
      `Invalid server name: "${manifest.serverName}". Must match /^[a-z0-9][a-z0-9._-]*$/`,
    );
  }

  // baseUrl is emitted into string literals across TS/Python/TOML/.env targets.
  // Sanitize once here so a malicious spec/flag value cannot break out of any of
  // them (lossless for real URLs).
  manifest = { ...manifest, baseUrl: sanitizeUrlLiteral(manifest.baseUrl) };
  if (!SAFE_VERSION_RE.test(manifest.serverVersion)) {
    logger.warn(`Unsafe server version "${manifest.serverVersion}" sanitized to "0.0.0"`);
    manifest = { ...manifest, serverVersion: '0.0.0' };
  }

  // Warn about features the Workers target does not emit (so nothing is silently
  // dropped). Tools — the dominant case — are always fully emitted.
  if ((manifest.resources?.length ?? 0) > 0 || (manifest.prompts?.length ?? 0) > 0) {
    logger.warn(
      `Cloudflare target emits tools only — ${manifest.resources?.length ?? 0} resource(s) ` +
        `and ${manifest.prompts?.length ?? 0} prompt(s) omitted. Use --target node to include them.`,
    );
  }
  if (manifest.tools.some((t) => t.isAsync)) {
    logger.warn(
      'Cloudflare target: async tools run synchronously within the request (no Tasks extension / background polling).',
    );
  }
  if (manifest.dynamicDiscovery) {
    logger.warn(
      'Cloudflare target does not support --dynamic-discovery; emitting all tools individually.',
    );
  }
  const workerAuthSchemes = manifest.authSchemes.filter((s) => s.type !== 'oauth2');
  if (workerAuthSchemes.length !== manifest.authSchemes.length) {
    logger.warn(
      'Cloudflare target: OAuth2 outbound auth is omitted (apiKey / bearer / basic are supported). Use --target node for OAuth2.',
    );
  }

  const authEnvVars = manifest.envVars.filter((v) => v.name !== 'BASE_URL');
  // The reused auth + config modules must see the filtered (no-oauth2) schemes so
  // they never reference an un-emitted oauth.ts.
  const templateData = {
    ...manifest,
    authSchemes: workerAuthSchemes,
    authEnvVars,
    hasOAuth: false,
    environmentsJson: environmentsJson(manifest),
  };

  const units: CodeUnit[] = [
    // Worker-specific files.
    { filePath: 'src/index.ts', content: renderWorkerTemplate('worker.ts', templateData) },
    { filePath: 'src/config.ts', content: renderWorkerTemplate('config.ts', templateData) },
    { filePath: 'package.json', content: renderWorkerTemplate('package.json', templateData) },
    { filePath: 'tsconfig.json', content: renderWorkerTemplate('tsconfig.json', templateData) },
    { filePath: 'wrangler.toml', content: renderWorkerTemplate('wrangler.toml', templateData) },
    { filePath: 'README.md', content: renderWorkerTemplate('readme.md', templateData) },
    {
      filePath: '.dev.vars.example',
      // Escape the dotenv VALUES (baseUrl, defaultEnvironment) at this emit
      // boundary so a value with a CR/LF or `#` cannot inject an extra
      // KEY=value line into the operator's `.dev.vars` (D-M3). Env NAMES are
      // already validated upstream in the Stainless translator. The wider
      // templateData keeps the raw (url-literal-sanitized) baseUrl for the
      // non-dotenv sinks (wrangler.toml, config.ts).
      content: renderWorkerTemplate('dev-vars.example', {
        ...templateData,
        baseUrl: escapeDotenvValue(manifest.baseUrl),
        defaultEnvironment: manifest.defaultEnvironment
          ? escapeDotenvValue(manifest.defaultEnvironment)
          : manifest.defaultEnvironment,
      }),
    },
    { filePath: '.gitignore', content: renderWorkerTemplate('gitignore', templateData) },
    // Runtime-agnostic modules reused from the Node templates (fetch / Buffer /
    // AsyncLocalStorage — all covered by nodejs_compat).
    { filePath: 'src/http.ts', content: renderTemplate('http-executor.ts', templateData) },
    {
      filePath: 'src/response-filter.ts',
      content: renderTemplate('response-filter.ts', templateData),
    },
    { filePath: 'src/auth.ts', content: renderTemplate('auth-provider.ts', templateData) },
    { filePath: 'src/trace.ts', content: renderTemplate('trace.ts', templateData) },
  ];

  for (const tool of manifest.tools) {
    units.push({
      filePath: `src/tools/${tool.fileName}.ts`,
      content: renderWorkerTemplate('tool-handler.ts', toToolHandlerView(tool, manifest)),
    });
  }
  units.push({
    filePath: 'src/tools/index.ts',
    content: renderWorkerTemplate('tool-index.ts', { tools: manifest.tools }),
  });
  units.push({
    filePath: 'test/server.test.ts',
    content: renderWorkerTemplate('server.test.ts', templateData),
  });

  logger.info(`Writing ${units.length} Workers files to ${options.outputDir}`);
  await writeCodeUnits(units, options.outputDir, options);
}

/**
 * Emit a Playwright-based MCP server project from a SiteProjectManifest.
 * Parallel to emitProject() but uses site-specific templates.
 */
export async function emitSiteProject(
  manifest: SiteProjectManifest,
  options: EmitOptions,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.serverName)) {
    throw new Error(
      `Invalid server name: "${manifest.serverName}". Must match /^[a-z0-9][a-z0-9._-]*$/`,
    );
  }

  // baseUrl is emitted into string literals across TS/Python/TOML/.env targets.
  // Sanitize once here so a malicious spec/flag value cannot break out of any of
  // them (lossless for real URLs).
  manifest = { ...manifest, baseUrl: sanitizeUrlLiteral(manifest.baseUrl) };

  if (!SAFE_VERSION_RE.test(manifest.serverVersion)) {
    logger.warn(`Unsafe server version "${manifest.serverVersion}" sanitized to "0.0.0"`);
    manifest = { ...manifest, serverVersion: '0.0.0' };
  }

  const units: CodeUnit[] = [];

  // Project skeleton (package.json, tsconfig, Dockerfile, .env.example, .gitignore)
  units.push(...scaffoldSiteProjectFiles(manifest));

  // Shared source modules (server entry, config, browser-manager, site-descriptor.json)
  units.push(...scaffoldSiteSharedModules(manifest));

  // Tool files — choose template based on tool type
  for (const tool of manifest.tools) {
    const templateName = getSiteToolTemplate(tool);
    units.push({
      filePath: `src/tools/${tool.fileName}.ts`,
      content: renderSiteTemplate(templateName, tool),
    });
  }

  // Tool index (registers all tools)
  units.push({
    filePath: 'src/tools/index.ts',
    content: renderSiteTemplate('tool-index.ts', { tools: manifest.tools }),
  });

  logger.info(`Writing ${units.length} files to ${options.outputDir}`);
  await writeCodeUnits(units, options.outputDir, options);
}

/** Pick the right template for a site tool based on its type. */
function getSiteToolTemplate(tool: SiteToolDefinition): string {
  switch (tool.toolType) {
    case 'browser-lifecycle':
      return 'tool-handler-lifecycle.ts';
    case 'page-action':
      return 'tool-handler-form.ts';
    case 'element-action':
    case 'navigation':
      return 'tool-handler-action.ts';
    default:
      return 'tool-handler-action.ts';
  }
}

/**
 * Build a Python-safe view of a tool (A4-H2). Path/query/header/cookie param
 * names become valid, de-duplicated Python identifiers (used as function args
 * and locals), while the original API name is preserved for the URL path token,
 * query-string key, and wire header/cookie name. Each param now also carries a
 * PRECISE Python type annotation derived from its JSON Schema so FastMCP infers
 * a full-fidelity input schema (types, enums, bounds, required, description)
 * instead of the previous all-`str` signature. The request body becomes a
 * Pydantic `BaseModel` when it is a plain object, falling back to `dict` for
 * array/free-form/complex bodies.
 *
 * @param tool   the tool to render
 * @param alloc  file-level model-name allocator (model class names are unique
 *               across ALL tools, since they are emitted at module scope)
 * @param models file-level accumulator of generated Pydantic model defs
 */
function toPythonToolView(
  tool: ToolDefinition,
  alloc: ModelNameAllocator,
  models: PydanticModel[],
): Record<string, unknown> {
  // Pre-seed with names that are either hardcoded args in server.py.hbs
  // ("body") or local variables used inside the tool body ("url", "params",
  // "req_headers", "resp", "raw", "data", "content_type", "client", "chunks",
  // "total", "headers").  A param that maps to any of these gets a _1/_2/…
  // suffix via uniquePyName so the emitted signature cannot have duplicate args
  // and cannot shadow a body-local variable.
  const used = new Set<string>([
    'body',
    'url',
    'params',
    'req_headers',
    'resp',
    'raw',
    'data',
    'content_type',
    'client',
    'chunks',
    'chunk',
    'total',
    'headers',
  ]);
  const uniquePyName = (apiName: string): string => {
    let base = sanitizePyIdentifier(apiName);
    let candidate = base;
    let i = 1;
    while (used.has(candidate)) candidate = `${base}_${i++}`;
    used.add(candidate);
    return candidate;
  };

  // Index the enriched mappings (carrying required/schema/description) by
  // wire-name+location so we can look up a param's schema while preserving the
  // existing path/query ordering (driven off pathParams/queryParams arrays).
  const mappingFor = (
    wireName: string,
    location: 'path' | 'query' | 'header' | 'cookie',
  ): { required?: boolean; schema?: import('../types/index.js').JsonSchema } | undefined =>
    tool.paramMappings.find((m) => m.in === location && m.wireName === wireName);

  // Compute the full annotation RHS (`int`, `Annotated[str | None, Field(...)] = None`,
  // …) for one parameter from its schema + required flag. Path params are always
  // required (no default); for others, optional → `| None = None`.
  const annotationFor = (
    wireName: string,
    location: 'path' | 'query' | 'header' | 'cookie',
    forceRequired: boolean,
  ): { annotation: string; optional: boolean } => {
    const m = mappingFor(wireName, location);
    const required = forceRequired || m?.required === true;
    const { annotation: base, fieldArgs } = jsonSchemaToPyAnnotation(m?.schema);
    const optional = !required;
    return { annotation: renderParamAnnotation(base, fieldArgs, optional), optional };
  };

  const pyPathParams = tool.pathParams.map((apiName) => {
    // Path params are required by definition; force no default.
    const { annotation } = annotationFor(apiName, 'path', true);
    return {
      apiName,
      pyName: uniquePyName(apiName),
      brace: `{${apiName}}`,
      annotation,
    };
  });
  const pyQueryParams = tool.queryParams.map((apiName) => {
    const { annotation, optional } = annotationFor(apiName, 'query', false);
    return {
      apiName,
      pyName: uniquePyName(apiName),
      annotation,
      optional,
    };
  });
  // Header/cookie request params (D-H2). Driven off paramMappings so the
  // function arg uses a sanitized, de-duplicated Python identifier while the
  // upstream request still uses the original wire name. De-duplicated by wire
  // name so a header/cookie repeated across mappings cannot emit two args.
  const dedupeByWire = (
    kind: 'header' | 'cookie',
  ): { wireName: string; pyName: string; annotation: string; optional: boolean }[] => {
    const seen = new Set<string>();
    const out: { wireName: string; pyName: string; annotation: string; optional: boolean }[] = [];
    for (const m of tool.paramMappings) {
      if (m.in !== kind || seen.has(m.wireName)) continue;
      seen.add(m.wireName);
      const { annotation, optional } = annotationFor(m.wireName, kind, false);
      out.push({ wireName: m.wireName, pyName: uniquePyName(m.wireName), annotation, optional });
    }
    return out;
  };
  const pyHeaderParams = dedupeByWire('header');
  const pyCookieParams = dedupeByWire('cookie');

  // Request body annotation (A4-H2). A plain-object body becomes a Pydantic
  // model (full nested-object fidelity); arrays / free-form / complex bodies
  // fall back to `dict | None` (the prior behavior) — documented in the template.
  let bodyAnnotation: string | undefined;
  let bodyIsModel = false;
  let bodyModelName: string | undefined;
  if (tool.hasRequestBody) {
    const bodySchema = tool.bodyParam?.schema;
    const bodyRequired = tool.bodyParam?.required === true;
    if (isModellableObject(bodySchema)) {
      bodyModelName = buildPydanticModel(bodySchema!, `${tool.functionName}_body`, alloc, models);
      bodyIsModel = true;
      bodyAnnotation = bodyRequired ? bodyModelName : `${bodyModelName} | None = None`;
    } else {
      // Fallback: array / free-form / $ref-still-present / non-object body.
      bodyAnnotation = 'dict | None = None';
    }
  }

  // Build the ORDERED function-signature parameter list. Python forbids a
  // non-default argument after a default one, so required params (no `= ...`)
  // MUST all precede optional params (`... = None`). We therefore partition by
  // optionality rather than by location: required path/query/header/cookie/body
  // first (in that stable location order), then all optionals. The body is
  // placed by its own optionality so a required body lands in the required group
  // and an optional body in the optional group.
  interface SigParam {
    text: string; // full `name: annotation[ = default]`
    optional: boolean;
  }
  const sigParams: SigParam[] = [];
  for (const p of pyPathParams)
    sigParams.push({ text: `${p.pyName}: ${p.annotation}`, optional: false });
  for (const p of pyQueryParams)
    sigParams.push({ text: `${p.pyName}: ${p.annotation}`, optional: p.optional });
  for (const p of pyHeaderParams)
    sigParams.push({ text: `${p.pyName}: ${p.annotation}`, optional: p.optional });
  for (const p of pyCookieParams)
    sigParams.push({ text: `${p.pyName}: ${p.annotation}`, optional: p.optional });
  if (tool.hasRequestBody && bodyAnnotation !== undefined) {
    const bodyOptional = bodyAnnotation.includes('= None');
    sigParams.push({ text: `body: ${bodyAnnotation}`, optional: bodyOptional });
  }
  // Stable partition: required first (preserving their relative order), then
  // optional (preserving theirs). Array.prototype.sort is not guaranteed stable
  // across all engines for this, so partition explicitly.
  const pySignature = [
    ...sigParams.filter((p) => !p.optional),
    ...sigParams.filter((p) => p.optional),
  ]
    .map((p) => p.text)
    .join(', ');

  // The emitted `async def {{functionName}}(...)` must be a legal Python
  // identifier and not a keyword. tool.functionName is camelCase derived from the
  // operationId for the TS target (where e.g. `class`/`import`/`return` are legal),
  // so sanitize it for Python and suffix `_` if it lands on a keyword — otherwise
  // a one-word keyword operationId emits `async def class(...)` → SyntaxError
  // (dead-on-import server). The MCP-visible tool name (`@server.tool(name=…)`)
  // uses the snake_case `name`, not this, so it is unaffected.
  let pyFunctionName = sanitizePyIdentifier(tool.functionName);
  if (isPyKeyword(pyFunctionName)) pyFunctionName = `${pyFunctionName}_`;

  return {
    ...tool,
    functionName: pyFunctionName,
    pyPathParams,
    pyQueryParams,
    pyHeaderParams,
    pyCookieParams,
    pySignature,
    bodyAnnotation,
    bodyIsModel,
    bodyModelName,
  };
}

/**
 * Emit a Python MCP server project.
 * Generates a single server.py file with all tools, plus requirements.txt.
 */
export async function emitPythonProject(
  manifest: ProjectManifest,
  options: EmitOptions,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.serverName)) {
    throw new Error(
      `Invalid server name: "${manifest.serverName}". Must match /^[a-z0-9][a-z0-9._-]*$/`,
    );
  }

  // baseUrl is emitted into string literals across TS/Python/TOML/.env targets.
  // Sanitize once here so a malicious spec/flag value cannot break out of any of
  // them (lossless for real URLs).
  manifest = { ...manifest, baseUrl: sanitizeUrlLiteral(manifest.baseUrl) };

  const units: CodeUnit[] = [];

  // File-level Pydantic model accumulator + name allocator. Models are emitted
  // once at module scope, so their class names must be unique across every tool
  // (A4-H2). The allocator is seeded with the runtime/import names already in
  // server.py so a generated model can never shadow them.
  const pydanticModels: PydanticModel[] = [];
  const modelAlloc = new ModelNameAllocator();
  const pyTools = manifest.tools.map((t) => toPythonToolView(t, modelAlloc, pydanticModels));

  const templateData = {
    ...manifest,
    tools: pyTools,
    // Joined Pydantic class defs to emit at module scope (before the tools).
    pydanticModels: pydanticModels.map((m) => m.source).join('\n'),
    authEnvVars: manifest.envVars.filter((v) => v.name !== 'BASE_URL'),
    environmentsJson: environmentsJson(manifest),
    // Gate the apiKey-in-query merge so projects without query auth are unchanged.
    hasQueryApiKey: hasQueryApiKey(manifest),
  };

  units.push({
    filePath: 'server.py',
    content: renderPythonTemplate('server.py', templateData),
  });

  units.push({
    filePath: 'requirements.txt',
    content: renderPythonTemplate('requirements.txt', manifest),
  });

  units.push({
    filePath: '.env.example',
    // Escape the dotenv VALUES (baseUrl, defaultEnvironment) at this emit
    // boundary so a value with a CR/LF or `#` cannot inject an extra KEY=value
    // line into the operator's `.env` (D-M3). Env NAMES are already validated
    // upstream. The wider templateData keeps the raw (url-literal-sanitized)
    // baseUrl for the Python string-literal sink in server.py.
    content: renderPythonTemplate('env.example', {
      ...templateData,
      baseUrl: escapeDotenvValue(manifest.baseUrl),
      defaultEnvironment: manifest.defaultEnvironment
        ? escapeDotenvValue(manifest.defaultEnvironment)
        : manifest.defaultEnvironment,
    }),
  });

  if (manifest.transport === 'http') {
    units.push({
      filePath: 'Dockerfile',
      content: renderPythonTemplate('dockerfile', manifest),
    });
  }

  logger.info(`Writing ${units.length} Python files to ${options.outputDir}`);
  await writeCodeUnits(units, options.outputDir, options);
}
