import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { testExecutionContext } from '@quilla-be-kit/execution-context/testing';
import { describe, expect, it } from 'vitest';
import { createTestHttpRequest } from '../src/testing.js';

describe('createTestHttpRequest', () => {
  it('defaults to an empty GET on /', () => {
    const req = createTestHttpRequest();
    expect(req.getMethod()).toBe('GET');
    expect(req.getPath()).toBe('/');
    expect(req.getQuery()).toEqual({});
    expect(req.getBody()).toBeNull();
  });

  it('lower-cases headers so getHeader matches the adapters', () => {
    const req = createTestHttpRequest({ headers: { 'X-Request-Id': 'r-1' } });
    expect(req.getHeader('x-request-id')).toBe('r-1');
  });

  it('resolves the context view from a fixed context', () => {
    const req = createTestHttpRequest({
      context: testExecutionContext({
        actorType: 'user',
        session: { scopeId: 's-1', userId: 'u-1' },
      }),
    });
    expect(req.getContext()).toMatchObject({ scopeId: 's-1', userId: 'u-1' });
  });

  it('reads a provider live', async () => {
    const provider = new AsyncExecutionContextProvider();
    const req = createTestHttpRequest({ context: provider });
    await provider.runWithContext(testExecutionContext({ scopeId: 's-2' }), async () => {
      expect(req.getContext().scopeId).toBe('s-2');
    });
  });

  it('explains how to fix a missing context', () => {
    expect(() => createTestHttpRequest().getContext()).toThrow(
      /pass `context` to createTestHttpRequest/,
    );
  });

  it('seeds the validated input', () => {
    expect(createTestHttpRequest({ validatedInput: { id: 1 } }).getValidatedInput()).toEqual({
      id: 1,
    });
  });
});
