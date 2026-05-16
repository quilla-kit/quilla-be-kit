import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { Context } from 'hono';
import type { HttpRequest } from '../../request/http-request.interface.js';
import type { HttpResponse } from '../../request/http-response.type.js';
import type { RequestAdapter } from '../../server/request-adapter.interface.js';
import { createHttpRequest } from './create-http-request.js';
import { getRequestAttributes } from './get-request-attributes.js';
import {
  HONO_CONTEXT_HTTP_REQUEST_KEY,
  HONO_CONTEXT_PARSED_BODY_KEY,
  type ParsedBody,
} from './hono.types.js';

export class HonoRequestAdapter implements RequestAdapter {
  constructor(private readonly executionContextProvider: ExecutionContextProvider | undefined) {}

  async toHttpRequest(frameworkContext: unknown): Promise<HttpRequest> {
    const c = frameworkContext as Context;
    const cached = c.get(HONO_CONTEXT_HTTP_REQUEST_KEY) as HttpRequest | undefined;
    if (cached) return cached;

    const attributes = getRequestAttributes(c);
    const { body, binary, formData } = await this.ensureParsedBody(c);

    const request = createHttpRequest(
      {
        path: c.req.path,
        method: c.req.method,
        query: normalizeQuery(c.req.queries()),
        params: c.req.param() as Record<string, string>,
        headers: normalizeHeaders(c.req.raw.headers),
        body,
        binary,
        formData,
        executionContextProvider: this.executionContextProvider,
      },
      attributes,
    );

    c.set(HONO_CONTEXT_HTTP_REQUEST_KEY, request);
    return request;
  }

  controller(
    handler: (request: HttpRequest) => Promise<HttpResponse>,
  ): (frameworkContext: unknown) => Promise<unknown> {
    return async (frameworkContext) => {
      const c = frameworkContext as Context;
      const request = await this.toHttpRequest(c);
      const response = await handler(request);
      return writeHonoResponse(c, response);
    };
  }

  private async ensureParsedBody(c: Context): Promise<ParsedBody> {
    const existing = c.get(HONO_CONTEXT_PARSED_BODY_KEY) as ParsedBody | undefined;
    if (existing) return existing;
    const parsed = await parseBody(c);
    c.set(HONO_CONTEXT_PARSED_BODY_KEY, parsed);
    return parsed;
  }
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function normalizeQuery(
  queries: Record<string, string[]>,
): Record<string, string | readonly string[]> {
  const out: Record<string, string | readonly string[]> = {};
  for (const [key, values] of Object.entries(queries)) {
    if (values.length === 0) continue;
    out[key] = values.length === 1 ? (values[0] as string) : values;
  }
  return out;
}

async function parseBody(c: Context): Promise<ParsedBody> {
  const contentType = c.req.header('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      return { body: await c.req.json(), formData: null, binary: null };
    }
    if (contentType.includes('multipart/form-data')) {
      return { body: null, formData: await c.req.formData(), binary: null };
    }
    if (
      contentType.includes('application/octet-stream') ||
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/')
    ) {
      return {
        body: null,
        formData: null,
        binary: new Uint8Array(await c.req.arrayBuffer()),
      };
    }
  } catch {
    // Malformed body — treat as empty; handlers/validators decide what's required.
  }

  return { body: null, formData: null, binary: null };
}

function writeHonoResponse(c: Context, response: HttpResponse): Response {
  const { httpCode, headers, ...rest } = response;
  const bodyKeys = Object.keys(rest);
  if (bodyKeys.length === 0) {
    return new Response(null, {
      status: httpCode,
      headers: headers ?? {},
    });
  }
  return c.json(rest, httpCode as never, headers);
}
