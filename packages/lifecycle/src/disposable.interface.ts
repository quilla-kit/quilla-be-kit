export interface Disposable {
  readonly name: string;
  dispose(): Promise<void>;
}
