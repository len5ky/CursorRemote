export interface Transport {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
