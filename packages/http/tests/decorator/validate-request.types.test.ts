import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  AuthorizeScope,
  Controller,
  Get,
  Post,
  ValidateRequest,
} from '../../src/decorator/index.js';
import type { HttpRequest } from '../../src/request/http-request.interface.js';
import type { HttpResponse } from '../../src/request/http-response.type.js';
import type { ValidatedRequest } from '../../src/validator/index.js';

const ListSchema = z.object({
  status: z.string().optional(),
  pagination: z.object({ page: z.number(), pageSize: z.number() }),
});
const OtherSchema = z.object({ other: z.number() });

@Controller('/types')
class Handlers {
  @Get('/derived')
  @AuthorizeScope('x:read')
  @ValidateRequest(ListSchema, ['query'])
  async derived(req: ValidatedRequest<typeof ListSchema>): Promise<HttpResponse> {
    const query = req.getValidatedInput();
    expectTypeOf(query).toEqualTypeOf<z.output<typeof ListSchema>>();
    // @ts-expect-error pageSize is nested under pagination
    query.pageSize;
    return { httpCode: 200, payload: query.pagination.pageSize };
  }

  @Post('/unread')
  @ValidateRequest(ListSchema, ['body'])
  async validatedButUnread(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200 };
  }

  @Get('/plain')
  async plain(req: HttpRequest): Promise<HttpResponse> {
    // @ts-expect-error validated input only exists on validated routes
    req.getValidatedInput();
    return { httpCode: 200 };
  }

  // @ts-expect-error handler annotated with a different schema's output
  @ValidateRequest(ListSchema, ['query'])
  async mismatched(_req: ValidatedRequest<typeof OtherSchema>): Promise<HttpResponse> {
    return { httpCode: 200 };
  }

  @ValidateRequest({ parse: (x: unknown) => x }, ['body'])
  async foreignSchema(req: ValidatedRequest<{ parse: unknown }>): Promise<HttpResponse> {
    const input: unknown = req.getValidatedInput();
    return { httpCode: 200, payload: input };
  }
}

describe('ValidatedRequest types', () => {
  it('compiles (the assertions are type-level)', () => {
    expect(new Handlers()).toBeDefined();
  });
});
