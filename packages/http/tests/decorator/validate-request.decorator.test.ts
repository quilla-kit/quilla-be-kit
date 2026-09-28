import type { ExecutionContext } from '@quilla-be-kit/execution-context';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidateRequest } from '../../src/decorator/index.js';
import { HttpAttributes } from '../../src/request/http-attributes.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import type { ValidatedRequest } from '../../src/validator/index.js';
import { SESSION_KEYS_ATTRIBUTE } from '../../src/validator/input-injection.metadata.js';
import type { RequestValidator } from '../../src/validator/request-validator.interface.js';
import { createZodRequestValidator } from '../../src/validator/zod.js';

const validator = createZodRequestValidator();

type FakeRequestInit = {
  readonly body?: unknown;
  readonly params?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly query?: Record<string, string>;
  readonly session?: { readonly scopeId: string; readonly userId: string } & Readonly<
    Record<string, unknown>
  >;
  readonly stampedKeys?: readonly string[];
  readonly validator?: RequestValidator;
};

function fakeRequest(init: FakeRequestInit = {}): ValidatedRequest<unknown> {
  const attributes = new Map<string, unknown>();
  attributes.set(HttpAttributes.REQUEST_VALIDATOR, init.validator ?? validator);
  if (init.stampedKeys) attributes.set(SESSION_KEYS_ATTRIBUTE, init.stampedKeys);

  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const executionContext: ExecutionContext = {
    actorType: 'user',
    correlationId: 'corr-1',
    executionAttemptId: 'attempt-1',
    ...(init.session ? { session: init.session } : {}),
  };

  return {
    getPath: () => '/',
    getMethod: () => 'POST',
    getQuery: () => init.query ?? {},
    getParams: () => init.params ?? {},
    getHeaders: () => headers,
    getHeader: (name: string) => headers[name.toLowerCase()] ?? null,
    getBody: () => init.body ?? null,
    getBinary: () => null,
    getFile: () => null,
    getFormFields: () => ({}),
    getExecutionContext: () => executionContext,
    setAttribute: <T>(key: string, value: T) => {
      attributes.set(key, value);
    },
    getAttribute: <T>(key: string) => attributes.get(key) as T | undefined,
    getValidatedInput: () => attributes.get(HttpAttributes.VALIDATED_INPUT),
  };
}

class Recorder {
  received: unknown;
}

describe('@ValidateRequest header-sourced injection', () => {
  it('auto-injects updatedAt from If-Match when the schema declares it, no headers arg needed', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ body: { name: 'Ada' }, headers: { 'If-Match': 'W/"abc"' } }),
    );

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'W/"abc"' });
  });

  it('leaves a body-supplied updatedAt untouched when If-Match is absent (no null-clobbering)', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(fakeRequest({ body: { name: 'Ada', updatedAt: 'from-body' } }));

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'from-body' });
  });

  it('a present If-Match header still wins over a body-supplied updatedAt', async () => {
    const schema = z.object({ name: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        body: { name: 'Ada', updatedAt: 'from-body' },
        headers: { 'If-Match': 'from-header' },
      }),
    );

    expect(instance.received).toEqual({ name: 'Ada', updatedAt: 'from-header' });
  });

  it('works for header-only requests with no body, like DELETE', async () => {
    const schema = z.object({ id: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 204 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ params: { id: 'widget-1' }, headers: { 'If-Match': 'v2' } }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', updatedAt: 'v2' });
  });

  it('an explicit headers map injects a non-default field', async () => {
    const schema = z.object({ id: z.string(), correlationId: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'], { correlationId: 'X-Correlation-Id' })
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({ params: { id: 'widget-1' }, headers: { 'X-Correlation-Id': 'corr-9' } }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', correlationId: 'corr-9' });
  });

  it('an explicit headers map overrides the default header name for updatedAt', async () => {
    const schema = z.object({ id: z.string(), updatedAt: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['params'], { updatedAt: 'X-Expected-Version' })
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        params: { id: 'widget-1' },
        headers: { 'If-Match': 'ignored', 'X-Expected-Version': 'v5' },
      }),
    );

    expect(instance.received).toEqual({ id: 'widget-1', updatedAt: 'v5' });
  });

  it('does not affect schemas without an updatedAt key or a headers arg (no regression)', async () => {
    const schema = z.object({ scopeId: z.string(), userId: z.string(), name: z.string() });

    class C extends Recorder {
      @ValidateRequest(schema, ['body'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }

    const instance = new C();
    await instance.handler(
      fakeRequest({
        body: { name: 'Ada' },
        session: { scopeId: 'scope-1', userId: 'user-1' },
      }),
    );

    expect(instance.received).toEqual({ scopeId: 'scope-1', userId: 'user-1', name: 'Ada' });
  });
});

describe('@ValidateRequest session-key injection', () => {
  const API_KEY_STACK = ['projectId'];
  const schema = z.object({ projectId: z.string(), name: z.string() });

  class C extends Recorder {
    @ValidateRequest(schema, ['query'])
    async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
      this.received = request.getValidatedInput();
      return { httpCode: 200 };
    }
  }

  const machineSession = { scopeId: 'scope-1', userId: 'user-1', projectId: 'project-1' };

  it('injects a stack key from the session, overwriting the client value', async () => {
    const instance = new C();
    await instance.handler(
      fakeRequest({
        query: { name: 'Ada', projectId: 'someone-elses-project' },
        session: machineSession,
        stampedKeys: API_KEY_STACK,
      }),
    );
    expect(instance.received).toEqual({ name: 'Ada', projectId: 'project-1' });
  });

  it('treats the same key as ordinary input on a stack that does not declare it', async () => {
    const instance = new C();
    await instance.handler(
      fakeRequest({
        query: { name: 'Ada', projectId: 'from-path' },
        session: machineSession,
        stampedKeys: [],
      }),
    );
    expect(instance.received).toEqual({ name: 'Ada', projectId: 'from-path' });
  });

  it('does not inject a stack key the schema does not declare', async () => {
    class Strict extends Recorder {
      @ValidateRequest(z.object({ name: z.string() }).strict(), ['query'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }
    const instance = new Strict();
    await instance.handler(
      fakeRequest({ query: { name: 'Ada' }, session: machineSession, stampedKeys: API_KEY_STACK }),
    );
    expect(instance.received).toEqual({ name: 'Ada' });
  });

  it('fails closed when a stamped route has no session', async () => {
    expect(() =>
      new C().handler(
        fakeRequest({ query: { name: 'Ada', projectId: 'p' }, stampedKeys: API_KEY_STACK }),
      ),
    ).toThrow(/session key "projectId" is declared by the auth stack but no session/);
  });

  it.each([
    ['missing', { scopeId: 'scope-1', userId: 'user-1' }],
    ['null', { scopeId: 'scope-1', userId: 'user-1', projectId: null }],
  ])('fails closed when the session value is %s', async (_label, session) => {
    expect(() =>
      new C().handler(fakeRequest({ query: { name: 'Ada' }, session, stampedKeys: API_KEY_STACK })),
    ).toThrow(/session has no value for declared key "projectId"/);
  });

  it('reads own session properties only, never the prototype chain', async () => {
    class Ctor extends Recorder {
      @ValidateRequest(z.object({ constructor: z.unknown() }), ['query'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }
    expect(() =>
      new Ctor().handler(
        fakeRequest({ session: machineSession, stampedKeys: [...API_KEY_STACK, 'constructor'] }),
      ),
    ).toThrow(/no value for declared key "constructor"/);
  });

  it('strips a stack key from client input when the validator cannot describe the schema', async () => {
    let seen: unknown;
    const opaque: RequestValidator = {
      validate: (_schema, input) => {
        seen = input;
        return { success: true, data: input };
      },
    };
    const instance = new C();
    await instance.handler(
      fakeRequest({
        query: { name: 'Ada', projectId: 'smuggled' },
        session: machineSession,
        stampedKeys: API_KEY_STACK,
        validator: opaque,
      }),
    );
    expect(seen).toEqual({ name: 'Ada' });
  });

  it('lets the session win over a header mapped to the same key', async () => {
    class Scoped extends Recorder {
      @ValidateRequest(z.object({ scopeId: z.string() }), ['query'], { scopeId: 'X-Scope-Id' })
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }
    const instance = new Scoped();
    await instance.handler(
      fakeRequest({ headers: { 'X-Scope-Id': 'forged' }, session: machineSession }),
    );
    expect(instance.received).toEqual({ scopeId: 'scope-1' });
  });

  it('injects base keys when a session exists without a stack stamp (e.g. set by a global middleware)', async () => {
    class Base extends Recorder {
      @ValidateRequest(z.object({ scopeId: z.string(), userId: z.string() }), ['query'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }
    const instance = new Base();
    await instance.handler(
      fakeRequest({ query: { scopeId: 'forged', userId: 'forged' }, session: machineSession }),
    );
    expect(instance.received).toEqual({ scopeId: 'scope-1', userId: 'user-1' });
  });

  it('keeps client-supplied base keys when there is no session and no stamp (unchanged behaviour)', async () => {
    class Base extends Recorder {
      @ValidateRequest(z.object({ scopeId: z.string() }), ['query'])
      async handler(request: ValidatedRequest<unknown>): Promise<HttpResponse> {
        this.received = request.getValidatedInput();
        return { httpCode: 200 };
      }
    }
    const instance = new Base();
    await instance.handler(fakeRequest({ query: { scopeId: 'public-scope' } }));
    expect(instance.received).toEqual({ scopeId: 'public-scope' });
  });
});
