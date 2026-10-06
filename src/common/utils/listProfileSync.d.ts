export interface ProfileSnapshot { version: 1, listIds: string[], profiles: Record<string, LX.List.UserListProfile> }
export function normalizeSnapshot(value: unknown): ProfileSnapshot
export function mergeSnapshots(local: ProfileSnapshot, remote: ProfileSnapshot, base?: ProfileSnapshot | null, mode?: string): ProfileSnapshot
export function snapshotsEqual(a: ProfileSnapshot, b: ProfileSnapshot): boolean
export function rebaseSnapshot(current: ProfileSnapshot, incoming: ProfileSnapshot, base: ProfileSnapshot): ProfileSnapshot
