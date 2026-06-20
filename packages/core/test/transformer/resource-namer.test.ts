import { describe, it, expect } from 'vitest';
import { deriveResourceName } from '../../src/transformer/naming.js';
import { resourceTreeNames } from '../../src/transformer/resource-namer.js';
import type { OperationDescriptor } from '../../src/types/index.js';

/** Minimal operation stub — resourceTreeNames only reads method/path/operationId. */
function op(method: string, path: string, operationId = 'origId'): OperationDescriptor {
  return {
    operationId,
    method,
    path,
    parameters: [],
    responses: [],
  } as unknown as OperationDescriptor;
}

describe('deriveResourceName — REST resource tree → tool name', () => {
  it('maps collection vs item by method', () => {
    expect(deriveResourceName('get', '/accounts')).toBe('list_accounts');
    expect(deriveResourceName('post', '/accounts')).toBe('create_account');
    expect(deriveResourceName('get', '/accounts/{id}')).toBe('get_account');
    expect(deriveResourceName('put', '/accounts/{id}')).toBe('update_account');
    expect(deriveResourceName('patch', '/accounts/{id}')).toBe('update_account');
    expect(deriveResourceName('delete', '/accounts/{id}')).toBe('delete_account');
  });

  it('handles nested sub-resources', () => {
    expect(deriveResourceName('get', '/accounts/{id}/cards')).toBe('list_account_cards');
    expect(deriveResourceName('post', '/accounts/{id}/cards')).toBe('create_account_card');
    expect(deriveResourceName('get', '/accounts/{id}/cards/{cardId}')).toBe('get_account_card');
    expect(deriveResourceName('delete', '/accounts/{id}/cards/{cardId}')).toBe(
      'delete_account_card',
    );
  });

  it('treats a singular literal after a param as a custom action verb', () => {
    expect(deriveResourceName('post', '/accounts/{id}/close')).toBe('close_account');
    expect(deriveResourceName('post', '/orders/{id}/cancel')).toBe('cancel_order');
  });

  it('singularizes resource nouns correctly', () => {
    expect(deriveResourceName('get', '/categories/{id}')).toBe('get_category');
    expect(deriveResourceName('get', '/addresses/{id}')).toBe('get_address');
    expect(deriveResourceName('post', '/companies')).toBe('create_company');
  });

  it('supports :param path style', () => {
    expect(deriveResourceName('get', '/users/:id')).toBe('get_user');
  });

  it('returns empty when there is no resource segment to name from', () => {
    expect(deriveResourceName('get', '/')).toBe('');
    expect(deriveResourceName('get', '')).toBe('');
    expect(deriveResourceName('get', '/{id}')).toBe('');
  });
});

describe('resourceTreeNames — rewrite operationIds', () => {
  it('rewrites derivable operations and preserves the rest', () => {
    const out = resourceTreeNames([
      op('get', '/accounts', 'listAccountsOld'),
      op('post', '/accounts', 'createAccountOld'),
      op('get', '/', 'rootOp'),
    ]);
    expect(out[0].operationId).toBe('list_accounts');
    expect(out[1].operationId).toBe('create_account');
    expect(out[2].operationId).toBe('rootOp'); // not derivable → kept
  });

  it('is collision-safe: first claimant wins, later collider keeps its id', () => {
    const out = resourceTreeNames([
      op('get', '/accounts/{id}', 'first'),
      op('get', '/accounts/{accountId}', 'second'), // also derives get_account
    ]);
    expect(out[0].operationId).toBe('get_account');
    expect(out[1].operationId).toBe('second'); // collision → original kept
  });

  it('does not mutate the input operations', () => {
    const input = [op('post', '/accounts', 'orig')];
    const out = resourceTreeNames(input);
    expect(input[0].operationId).toBe('orig');
    expect(out[0].operationId).toBe('create_account');
  });
});
