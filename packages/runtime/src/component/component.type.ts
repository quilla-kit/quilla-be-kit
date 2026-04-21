export type Component<TMeta = unknown> = {
  readonly name: string;
  readonly meta?: TMeta;
  dispose?(): Promise<void>;
};
