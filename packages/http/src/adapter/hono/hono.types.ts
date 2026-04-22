export type ParsedBody = {
  readonly body: unknown;
  readonly formData: FormData | null;
  readonly binary: Uint8Array | null;
};

export const HONO_CONTEXT_ATTRIBUTES_KEY = '__quilla_http_attributes__';
export const HONO_CONTEXT_PARSED_BODY_KEY = '__quilla_http_parsed_body__';
