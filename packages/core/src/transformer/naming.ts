export function toToolName(operationId: string): string {
  return toSnakeCase(operationId);
}

export function toToolTitle(operationId: string): string {
  const snake = toSnakeCase(operationId);
  return snake
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function toFileName(operationId: string): string {
  return toSnakeCase(operationId)
    .replace(/_/g, '-')
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')
    .replace(/[^a-z0-9\-]/g, '');
}

export function toFunctionName(operationId: string): string {
  const snake = toSnakeCase(operationId);
  return snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s\-]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}
