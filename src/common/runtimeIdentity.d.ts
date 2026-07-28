export type SyncClientClassification =
  | Readonly<{ kind: 'desktop', isMobile: false }>
  | Readonly<{ kind: 'mobile', isMobile: true }>

export interface SyncClientIdentity {
  readonly syncDesktopId: string
  readonly syncMobileId: string
}

export function createUrlSchemeRxp(protocolScheme: string): RegExp
export function classifySyncClient(clientType: unknown, identity: SyncClientIdentity): SyncClientClassification | null
