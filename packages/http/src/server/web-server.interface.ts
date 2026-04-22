export interface WebServer {
  bootstrap(): void | Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}
