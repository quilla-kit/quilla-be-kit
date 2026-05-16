export type ValidationResult =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: readonly unknown[] };
