export function toToolName(operationId: string): string {
  return toSnakeCase(operationId) || 'tool';
}

export function toToolTitle(operationId: string): string {
  const snake = toSnakeCase(operationId) || 'tool';
  return snake
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function toFileName(operationId: string): string {
  return (
    toSnakeCase(operationId)
      .replace(/_/g, '-')
      .replace(/[^a-z0-9\-]/g, '') || 'tool'
  );
}

export function toFunctionName(operationId: string): string {
  const snake = toSnakeCase(operationId) || 'tool';
  const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  // A function name must be a valid JS identifier — prefix when it would start
  // with a digit (operationIds like "2fa" snake to "2fa").
  return /^[A-Za-z_]/.test(camel) ? camel : `_${camel}`;
}

/**
 * Normalize to snake_case AND strip to a safe identifier charset `[a-z0-9_]`.
 * The charset strip is load-bearing for codegen safety: operationIds, tags and
 * param names flow into generated source as tool names / titles / identifiers,
 * and an unsanitized `'` or backtick would break out of the emitted literal.
 */
function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s\-]+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

const PARAM_SEGMENT = /^[:{].*[}]?$/; // {id}, {id} or :id style path params

function isParamSegment(seg: string): boolean {
  return PARAM_SEGMENT.test(seg) || seg.startsWith('{') || seg.startsWith(':');
}

/** Naive English singularization — dependency-free, good enough for resource nouns. */
function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(s|x|z|ch|sh)es$/i.test(word)) return word.replace(/es$/i, '');
  if (/ss$/i.test(word)) return word; // "address" stays "address"
  if (/s$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

/**
 * Derive a Stainless-style tool name from an HTTP method + path's resource tree,
 * instead of the operationId. Mirrors the REST resource/method convention:
 *
 *   GET    /accounts                  -> list_accounts
 *   POST   /accounts                  -> create_account
 *   GET    /accounts/{id}             -> get_account
 *   PUT    /accounts/{id}             -> update_account
 *   DELETE /accounts/{id}             -> delete_account
 *   GET    /accounts/{id}/cards       -> list_account_cards
 *   GET    /accounts/{id}/cards/{cid} -> get_account_card
 *   POST   /accounts/{id}/close       -> close_account   (custom action verb)
 *
 * Returns '' when the path has no literal (resource) segments to name from, so
 * callers can fall back to the operationId.
 */
export function deriveResourceName(method: string, path: string): string {
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return '';

  const last = segs[segs.length - 1];
  const endsWithItem = isParamSegment(last);
  let literals = segs.filter((s) => !isParamSegment(s));
  if (literals.length === 0) return '';

  const m = method.toLowerCase();

  // Custom action: a trailing literal that sits right after a path param and is
  // not a plural noun (e.g. /accounts/{id}/close) reads as a verb on the parent
  // resource, not a sub-collection (/accounts/{id}/cards).
  let action: string | undefined;
  if (!endsWithItem && segs.length >= 2 && isParamSegment(segs[segs.length - 2])) {
    const lastLiteral = literals[literals.length - 1];
    if (!/s$/i.test(lastLiteral)) {
      action = lastLiteral;
      literals = literals.slice(0, -1);
    }
  }
  if (literals.length === 0) return ''; // action with no parent resource → give up

  let verb: string;
  if (action) {
    verb = action;
  } else {
    switch (m) {
      case 'get':
      case 'head':
        verb = endsWithItem ? 'get' : 'list';
        break;
      case 'post':
        verb = 'create';
        break;
      case 'put':
      case 'patch':
        verb = 'update';
        break;
      case 'delete':
        verb = 'delete';
        break;
      default:
        verb = m;
    }
  }

  const terminal = literals[literals.length - 1];
  const parents = literals.slice(0, -1).map(singularize);
  // Keep the terminal noun plural only for collection listing (list_accounts).
  const terminalNoun = verb === 'list' && !action ? terminal : singularize(terminal);
  const chain = [...parents, terminalNoun].join('_');

  return toSnakeCase(`${verb}_${chain}`);
}
