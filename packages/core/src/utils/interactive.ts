import { createInterface } from 'node:readline';
import type { OperationDescriptor } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Show detected operations and let user confirm, skip, or rename before generation.
 * Returns the filtered/modified list of operations to proceed with.
 */
export async function confirmOperations(
  operations: OperationDescriptor[],
): Promise<OperationDescriptor[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

  logger.info('');
  logger.info(`Detected ${operations.length} operations:`);
  logger.info('');

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    logger.info(
      `  ${i + 1}. [${op.method.toUpperCase()}] ${op.path} → ${op.operationId}` +
        (op.summary ? ` — ${op.summary}` : ''),
    );
  }

  logger.info('');
  const answer = await ask(
    'Enter numbers to exclude (comma-separated), or press Enter to keep all: ',
  );
  rl.close();

  if (!answer.trim()) return operations;

  const excludeIndices = new Set(
    answer
      .split(',')
      .map((s) => parseInt(s.trim(), 10) - 1)
      .filter((n) => !isNaN(n) && n >= 0 && n < operations.length),
  );

  const result = operations.filter((_, i) => !excludeIndices.has(i));
  logger.info(`Proceeding with ${result.length} operations (excluded ${excludeIndices.size})`);
  return result;
}
