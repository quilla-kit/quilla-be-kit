/**
 * Where a write DAO reads the acting user for `inserted_by`/`updated_by`.
 * An `ExecutionContextProvider` from `@quilla-be-kit/execution-context`
 * satisfies it, and so does any object with this shape.
 */
export interface ActorProvider {
  getContext(): { readonly session?: { readonly userId?: string | undefined } | undefined };
}
