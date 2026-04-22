export type SignTokenPayload = {
  readonly userId: string;
  readonly scopeId: string;
  readonly securityStamp: string;
  readonly scope?: readonly string[];
};
