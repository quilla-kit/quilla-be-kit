export const HttpAttributes = {
  VERIFIED_TOKEN: 'verifiedToken',
  /**
   * Name of the auth stack that authenticated the request. Set by Router before
   * the stack runs, so guards can assert *which* stack authenticated the caller
   * — `scopes` share one flat namespace across stacks and cannot carry that.
   */
  AUTH_STACK: 'authStack',
  VALIDATED_INPUT: '__validated_input__',
  REQUEST_VALIDATOR: '__request_validator__',
} as const;
