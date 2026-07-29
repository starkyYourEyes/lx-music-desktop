type RemoteValue<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object ? { [K in keyof T]: RemoteValue<T[K]> } : never
export type SyncRpcWireProtocol = 'legacy' | 'current'
export type SyncRpcWireProtocolOption =
  | SyncRpcWireProtocol
  | (() => SyncRpcWireProtocol)
export interface SyncRpcOptions {
  funcsObj: Record<string, unknown>
  timeout?: number
  wireProtocol?: SyncRpcWireProtocolOption
  sendMessage: (data: Record<string, unknown>) => void | Promise<void>
  onCallBeforeParams?: (rawArgs: unknown[]) => unknown[] | Promise<unknown[]>
  onError?: (error: Error, path: string[], groupName: string | null) => void
}
export interface SyncRpc<TRemote> {
  remote: RemoteValue<TRemote>
  createQueueRemote: <TGroup>(groupName: string) => RemoteValue<TGroup>
  message: (data: unknown) => void
  destroy: () => void
}
export const createSyncRpc: <TRemote = Record<string, unknown>>(options: SyncRpcOptions) => SyncRpc<TRemote>
