type HttpResponseBase = {
  readonly httpCode: number;
  readonly headers?: Record<string, string>;
};

export type HttpJsonResponse = HttpResponseBase & {
  readonly payload?: unknown;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly details?: unknown;
  };
  readonly metadata?: {
    readonly pagination?: {
      readonly total: number;
      readonly page: number;
      readonly limit: number;
    };
  };
};

export type HttpBinaryResponse = HttpResponseBase & {
  readonly data: Uint8Array;
};

export type HttpStreamResponse = HttpResponseBase & {
  readonly stream: ReadableStream<Uint8Array>;
};

export type HttpResponse = HttpJsonResponse | HttpBinaryResponse | HttpStreamResponse;
