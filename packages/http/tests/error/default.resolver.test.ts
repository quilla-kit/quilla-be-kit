import {
  ConflictError,
  ExternalError,
  ForbiddenError,
  GoneError,
  InternalError,
  NotFoundError,
  NotImplementedError,
  PaymentRequiredError,
  PreconditionFailedError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UnavailableError,
  ValidationError,
} from '@quilla-be-kit/errors';
import { QuillaError } from '@quilla-be-kit/errors';
import { describe, expect, it } from 'vitest';
import { DefaultErrorResolver } from '../../src/error/default.resolver.js';
import { HTTP_STATUS, type HttpStatusAware } from '../../src/error/http-status-aware.interface.js';

class TeapotError extends QuillaError implements HttpStatusAware {
  readonly code: string = 'TEAPOT';
  readonly [HTTP_STATUS] = 418;
}

class BrandedNotFoundError extends NotFoundError implements HttpStatusAware {
  override readonly code: string = 'BRANDED_NOT_FOUND';
  readonly [HTTP_STATUS] = 410;
}

class UserNotFoundError extends NotFoundError {
  override readonly code: string = 'USER_NOT_FOUND';
}

class UpstreamError extends ExternalError {
  override readonly code: string = 'UPSTREAM';
  readonly httpCode = 404;
}

class BadBrandError extends QuillaError {
  readonly code: string = 'BAD_BRAND';
  constructor(status: unknown) {
    super({ message: 'bad brand' });
    Object.defineProperty(this, HTTP_STATUS, { value: status });
  }
}

describe('DefaultErrorResolver', () => {
  const resolver = new DefaultErrorResolver();

  it.each([
    [new ValidationError({ message: 'invalid' }), 400],
    [new UnauthorizedError({ message: 'unauth' }), 401],
    [new ForbiddenError({ message: 'forbidden' }), 403],
    [new NotFoundError({ message: 'not found' }), 404],
    [new ConflictError({ message: 'conflict' }), 409],
    [new ExternalError({ message: 'bad gateway' }), 502],
    [new InternalError({ message: 'internal' }), 500],
    [new PaymentRequiredError({ message: 'payment required' }), 402],
    [new GoneError({ message: 'gone' }), 410],
    [new PreconditionFailedError({ message: 'precondition failed' }), 412],
    [new RateLimitError({ message: 'slow down' }), 429],
    [new NotImplementedError({ message: 'not implemented' }), 501],
    [new UnavailableError({ message: 'unavailable' }), 503],
    [new TimeoutError({ message: 'timed out' }), 504],
  ])('%o → %i', (err, expectedCode) => {
    const result = resolver.resolve(err);
    expect(result.httpCode).toBe(expectedCode);
    expect(result.body.error?.name).toBe(err.name);
    expect(result.body.error?.message).toBe(err.message);
  });

  it('includes context as details when present', () => {
    const err = new ValidationError({
      message: 'fail',
      context: { issues: [{ path: 'email', message: 'required' }] },
    });
    const result = resolver.resolve(err);
    expect(result.body.error?.details).toEqual({
      issues: [{ path: 'email', message: 'required' }],
    });
  });

  it('uses a declared HTTP_STATUS brand', () => {
    expect(resolver.resolve(new TeapotError({ message: 'teapot' })).httpCode).toBe(418);
  });

  it('lets the brand outrank the category chain', () => {
    expect(resolver.resolve(new BrandedNotFoundError({ message: 'gone' })).httpCode).toBe(410);
  });

  it('still maps an unbranded subclass by its category', () => {
    expect(resolver.resolve(new UserNotFoundError({ message: 'no user' })).httpCode).toBe(404);
  });

  it('maps a subclass of a new category by inheritance', () => {
    class ResourceRetiredError extends GoneError {
      override readonly code: string = 'RESOURCE_RETIRED';
    }
    expect(resolver.resolve(new ResourceRetiredError({ message: 'retired' })).httpCode).toBe(410);
  });

  it('ignores a plain httpCode field that was never branded', () => {
    expect(resolver.resolve(new UpstreamError({ message: 'upstream 404' })).httpCode).toBe(502);
  });

  it.each([0, 700, 99, 600, Number.NaN, 410.5, '410', null])(
    'ignores an out-of-range or non-integer brand (%s)',
    (status) => {
      expect(resolver.resolve(new BadBrandError(status)).httpCode).toBe(500);
    },
  );

  it('keeps the generic 500 body for a branded non-QuillaError', () => {
    const err = Object.assign(new Error('boom'), { [HTTP_STATUS]: 410 });
    const result = resolver.resolve(err);
    expect(result.httpCode).toBe(500);
    expect(result.body.error?.name).toBe('InternalError');
    expect(result.body.error?.message).toBe('Internal server error');
  });

  it('falls back to 500 with generic body for non-QuillaError values', () => {
    const result = resolver.resolve(new Error('boom'));
    expect(result.httpCode).toBe(500);
    expect(result.body.error?.name).toBe('InternalError');
    expect(result.body.error?.message).toBe('Internal server error');
  });

  it('handles thrown primitives without crashing', () => {
    const result = resolver.resolve('string thrown');
    expect(result.httpCode).toBe(500);
    expect(result.body.error?.name).toBe('InternalError');
  });
});
