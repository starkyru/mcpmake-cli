/**
 * Map JSON Schema fragments onto precise Python type annotations + Pydantic
 * models so the generated FastMCP server's inferred tool inputSchema regains
 * full fidelity (A4-H2).
 *
 * FastMCP infers a tool's inputSchema from the handler function SIGNATURE, so
 * the fidelity of the schema is exactly the fidelity of the annotations we emit:
 *   - scalars → `str` / `int` / `float` / `bool`
 *   - string enums → `Literal["a", "b", ...]`
 *   - arrays → `list[<item>]`
 *   - bounds (`minimum`/`maxLength`/…) → `Field(ge=.., max_length=.., ...)`
 *   - a plain-object request body → a Pydantic `BaseModel` (nested objects
 *     become nested models), which FastMCP expands into a nested object schema.
 *
 * Everything an OpenAPI schema can throw at us that we cannot model precisely
 * (`$ref` left unresolved, `allOf`/`oneOf`/`anyOf`, free-form objects) degrades
 * to a permissive but always-VALID annotation (`str`, `Any`, `dict`) — the
 * emitter must never produce Python that fails to import.
 */
import type { JsonSchema } from '../types/index.js';
import { sanitizePyIdentifier } from '../utils/sanitize.js';

/** A Python type annotation plus the `Field(...)` keyword args it needs. */
export interface PyAnnotation {
  /** The base Python type, e.g. `int`, `Literal["a", "b"]`, `list[str]`. */
  annotation: string;
  /** Ordered `Field(...)` kwargs, e.g. `['ge=1', 'le=100', 'description="..."']`. */
  fieldArgs: string[];
}

/**
 * Escape a string for a double-quoted Python literal. Kept local (rather than
 * importing the Handlebars-bound `escapePyString`) so this module has no
 * template-loader dependency and stays unit-testable in isolation.
 */
function pyStringLiteral(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')}"`;
}

/** A JSON-Schema `type` may be a string or an array of strings (OpenAPI 3.1). */
function primaryType(schema: JsonSchema): string | undefined {
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    // Prefer the first non-"null" member (nullable shorthand) for the base type.
    const nonNull = t.find((x) => x !== 'null');
    return typeof nonNull === 'string' ? nonNull : undefined;
  }
  return undefined;
}

/** Collect numeric/string-length/pattern bounds into `Field(...)` kwargs. */
function boundsFieldArgs(schema: JsonSchema): string[] {
  const args: string[] = [];
  const numeric = (key: keyof JsonSchema, kw: string): void => {
    const v = schema[key];
    if (typeof v === 'number' && Number.isFinite(v)) args.push(`${kw}=${v}`);
  };
  numeric('minimum', 'ge');
  numeric('maximum', 'le');
  // OpenAPI 3.0 boolean exclusiveMinimum/Maximum pairs with minimum/maximum;
  // only the 3.1 numeric form maps cleanly to gt/lt, so guard on `typeof number`
  // (the `numeric` helper already does). A boolean value is ignored.
  numeric('exclusiveMinimum', 'gt');
  numeric('exclusiveMaximum', 'lt');
  numeric('minLength', 'min_length');
  numeric('maxLength', 'max_length');
  if (typeof schema.pattern === 'string' && schema.pattern.length > 0) {
    args.push(`pattern=${pyStringLiteral(schema.pattern)}`);
  }
  return args;
}

/**
 * Map a (non-body-root) schema to a Python base type. Body objects are handled
 * separately as Pydantic models; here an `object` degrades to `dict`. Returns
 * only the base type string — bounds/description are added by the caller.
 */
function baseTypeFor(schema: JsonSchema | undefined): string {
  if (!schema || typeof schema !== 'object') return 'Any';

  // String enum → Literal[...]. Only a homogeneous all-string enum maps to a
  // Literal; a mixed-type enum degrades to the base scalar type below.
  const enumVals = schema.enum;
  if (
    Array.isArray(enumVals) &&
    enumVals.length > 0 &&
    enumVals.every((v) => typeof v === 'string')
  ) {
    const members = (enumVals as string[]).map(pyStringLiteral).join(', ');
    return `Literal[${members}]`;
  }

  const t = primaryType(schema);
  switch (t) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'array': {
      const items = schema.items;
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        return `list[${baseTypeFor(items as JsonSchema)}]`;
      }
      return 'list';
    }
    case 'object':
      return 'dict';
    default:
      // Unknown / unresolved $ref / allOf|oneOf|anyOf with no `type`: stay
      // permissive but valid. `Any` accepts anything and never breaks import.
      return 'Any';
  }
}

/**
 * Produce the base Python type + Field kwargs for a single path/query/header/
 * cookie parameter (or a nested non-object body property). `optional` is handled
 * by the caller (it wraps the base type in `| None` and appends `= None`).
 */
export function jsonSchemaToPyAnnotation(schema: JsonSchema | undefined): PyAnnotation {
  const annotation = baseTypeFor(schema);
  const fieldArgs = schema ? boundsFieldArgs(schema) : [];
  if (schema && typeof schema.description === 'string' && schema.description.length > 0) {
    fieldArgs.push(`description=${pyStringLiteral(schema.description)}`);
  }
  return { annotation, fieldArgs };
}

/**
 * Render a complete parameter annotation (the text after the `:` in a function
 * signature) for a base type + Field kwargs + optionality.
 *
 *   required, no args   → `int`
 *   required, args      → `Annotated[int, Field(ge=1)]`
 *   optional, no args   → `int | None = None`
 *   optional, args      → `Annotated[int | None, Field(ge=1)] = None`
 *
 * Returns the full RHS so the template stays a dumb interpolation.
 */
export function renderParamAnnotation(
  base: string,
  fieldArgs: string[],
  optional: boolean,
): string {
  const typePart = optional ? `${base} | None` : base;
  const suffix = optional ? ' = None' : '';
  if (fieldArgs.length === 0) {
    return `${typePart}${suffix}`;
  }
  return `Annotated[${typePart}, Field(${fieldArgs.join(', ')})]${suffix}`;
}

/** Whether a body schema is a plain object we can faithfully model as a Pydantic class. */
export function isModellableObject(schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (primaryType(schema) !== 'object') return false;
  const props = schema.properties;
  return (
    !!props && typeof props === 'object' && !Array.isArray(props) && Object.keys(props).length > 0
  );
}

/** A generated Pydantic model: its class name and the full source of its `class` block. */
export interface PydanticModel {
  className: string;
  source: string;
}

/**
 * Allocates unique, valid, non-reserved Pydantic model class names. Seeded with
 * Python/runtime names that already appear in server.py so a model can never
 * shadow `BaseModel`, `Field`, `FastMCP`, etc.
 */
export class ModelNameAllocator {
  private readonly used: Set<string>;

  constructor(seed: Iterable<string> = []) {
    this.used = new Set<string>([
      // Imported / runtime names the model defs sit alongside in server.py.
      'BaseModel',
      'Field',
      'ConfigDict',
      'FastMCP',
      'TextContent',
      'Annotated',
      'Literal',
      'Optional',
      'Any',
      'BASE_URL',
      'server',
      'client',
      ...seed,
    ]);
  }

  allocate(hint: string): string {
    // PascalCase the hint, strip to identifier chars, prefix when it would start
    // with a digit / be empty so the class name is always valid Python.
    const cleaned = sanitizePyIdentifier(hint);
    const pascal = cleaned
      .split('_')
      .filter(Boolean)
      .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
      .join('');
    let base = pascal && /^[A-Za-z]/.test(pascal) ? pascal : `Model${pascal}`;
    if (!base) base = 'Model';
    let candidate = base;
    let n = 1;
    while (this.used.has(candidate)) candidate = `${base}${n++}`;
    this.used.add(candidate);
    return candidate;
  }
}

/**
 * Generate a Pydantic `BaseModel` class for a plain-object schema, recursing for
 * nested object properties (each becomes its own nested model). Appends every
 * model it creates to `models` (parent last is fine — Python resolves names
 * lazily at runtime, but we emit children before parents so the source reads
 * top-down). Returns the class name to reference for this object.
 *
 * Property keys that are not valid Python identifiers (e.g. `user-id`) use a
 * sanitized field name plus `Field(alias="<wireKey>")`; the model carries
 * `model_config = ConfigDict(populate_by_name=True)` so it accepts either name,
 * and the handler serializes with `by_alias=True` to send the original wire key.
 */
export function buildPydanticModel(
  schema: JsonSchema,
  nameHint: string,
  alloc: ModelNameAllocator,
  models: PydanticModel[],
): string {
  const className = alloc.allocate(nameHint);
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const requiredList = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const requiredSet = new Set(requiredList);

  const fieldLines: string[] = [];
  let needsAlias = false;
  const usedFieldNames = new Set<string>();

  for (const [wireKey, propSchema] of Object.entries(props)) {
    const isRequired = requiredSet.has(wireKey);

    // Determine the python field name. Valid identifiers are used as-is; anything
    // else is sanitized and aliased to the wire key. De-dupe sanitized names so
    // two wire keys that sanitize to the same identifier don't collide.
    // NOTE: a Pydantic v2 model field may NOT begin with `_` (those are treated
    // as private attributes — `NameError: Fields must not use names with leading
    // underscores`). So a leading-underscore wire key is NOT a valid field name
    // here (unlike a function arg), and the sanitizer must never emit a leading
    // `_`. sanitizePyFieldName prefixes `f_` instead.
    const validIdent =
      /^[A-Za-z][A-Za-z0-9_]*$/.test(wireKey) &&
      !isPyKeyword(wireKey) &&
      !isReservedPydanticField(wireKey);
    let fieldName = validIdent ? wireKey : sanitizePyFieldName(wireKey);
    while (usedFieldNames.has(fieldName)) fieldName = `${fieldName}_`;
    usedFieldNames.add(fieldName);
    const aliased = fieldName !== wireKey;
    if (aliased) needsAlias = true;

    // Nested plain-object property → its own model; otherwise a scalar/array.
    let baseType: string;
    let fieldArgs: string[];
    if (isModellableObject(propSchema)) {
      baseType = buildPydanticModel(propSchema, `${className}_${fieldName}`, alloc, models);
      fieldArgs = [];
      if (typeof propSchema.description === 'string' && propSchema.description.length > 0) {
        fieldArgs.push(`description=${pyStringLiteral(propSchema.description)}`);
      }
    } else {
      const ann = jsonSchemaToPyAnnotation(propSchema);
      baseType = ann.annotation;
      fieldArgs = ann.fieldArgs;
    }

    const typePart = isRequired ? baseType : `${baseType} | None`;

    // Compose the Field(...) call. alias must come first for readability; the
    // default sentinel for an optional field is `None` (passed as the Field
    // default so the property is genuinely optional in the inferred schema).
    const callArgs: string[] = [];
    if (aliased) callArgs.push(`alias=${pyStringLiteral(wireKey)}`);
    if (!isRequired) callArgs.push('default=None');
    callArgs.push(...fieldArgs);

    let rhs: string;
    if (callArgs.length === 0) {
      // Required, no metadata, valid identifier → bare typed field.
      rhs = '';
    } else {
      rhs = ` = Field(${callArgs.join(', ')})`;
    }
    fieldLines.push(`    ${fieldName}: ${typePart}${rhs}`);
  }

  const header = `class ${className}(BaseModel):`;
  const configLine = needsAlias ? '    model_config = ConfigDict(populate_by_name=True)\n' : '';
  const body = fieldLines.length > 0 ? fieldLines.join('\n') : '    pass';
  const source = `${header}\n${configLine}${body}\n`;
  models.push({ className, source });
  return className;
}

/**
 * Whether a wire key — even though it's a syntactically valid Python identifier —
 * would be rejected by Pydantic v2 as a model field name. Pydantic reserves the
 * `model_` namespace (`model_config` is the special class attribute; `model_dump`/
 * `model_validate`/… are BaseModel methods), so a body property literally named
 * `model_config`/`model_dump` (common in ML/AI API specs) would otherwise crash
 * the generated server at import. Such keys are remapped to an `f_`-prefixed
 * field with `Field(alias="<wireKey>")` preserving the wire name.
 */
function isReservedPydanticField(name: string): boolean {
  return name.startsWith('model_');
}

/**
 * Sanitize a wire key into a legal Pydantic v2 model FIELD name. Like
 * {@link sanitizePyIdentifier} but it never emits a leading underscore (Pydantic
 * rejects `_`-leading field names) — a result that wouldn't start with a letter
 * is prefixed with `f_`. A Python keyword or a Pydantic-reserved (`model_…`) name
 * is also remapped. The original wire key is preserved via `Field(alias=…)`, so
 * the on-the-wire name is unchanged.
 */
function sanitizePyFieldName(wireKey: string): string {
  let id = wireKey.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z]/.test(id)) id = `f_${id}`;
  if (isPyKeyword(id)) id = `${id}_`;
  if (isReservedPydanticField(id)) id = `f_${id}`;
  return id;
}

const PY_KEYWORDS = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
  'match',
  'case',
]);

export function isPyKeyword(name: string): boolean {
  return PY_KEYWORDS.has(name);
}
