export type HttpResponse = {
  readonly httpCode: number;
  readonly headers?: Record<string, string>;
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
