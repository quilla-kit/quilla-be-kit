import { type HttpMethod, addRoute } from './route.metadata.js';

export type RouteOptions = {
  // Per-route version segment. Inserted resource-first into the composed path
  // and overrides any controller- or module-level version. Goes through the
  // same slash normalization as every other segment.
  readonly version?: string;
};

function createMethodDecorator(httpMethod: HttpMethod, isPublic: boolean) {
  return (path: string, options?: RouteOptions) => {
    return (_target: unknown, context: ClassMethodDecoratorContext): void => {
      if (context.kind !== 'method') {
        throw new Error(`@${httpMethod} can only be applied to methods`);
      }
      addRoute(context.metadata as Record<string | symbol, unknown>, {
        handlerMethodName: context.name as string,
        httpMethod,
        path,
        public: isPublic,
        version: options?.version,
      });
    };
  };
}

export const Get = createMethodDecorator('GET', false);
export const Post = createMethodDecorator('POST', false);
export const Put = createMethodDecorator('PUT', false);
export const Patch = createMethodDecorator('PATCH', false);
export const Delete = createMethodDecorator('DELETE', false);

export const GetPublic = createMethodDecorator('GET', true);
export const PostPublic = createMethodDecorator('POST', true);
export const PutPublic = createMethodDecorator('PUT', true);
export const PatchPublic = createMethodDecorator('PATCH', true);
export const DeletePublic = createMethodDecorator('DELETE', true);
