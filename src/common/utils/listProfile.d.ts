export function isRecord(value: unknown): value is Record<string, unknown>
export function isPortableCover(value: unknown): value is string
export function normalizeProfile(value: unknown): LX.List.UserListProfile
export function resolveGroup(list: { source?: unknown, sourceListId?: unknown }, profile?: LX.List.UserListProfile): LX.List.UserListGroup
export function moveWithinGroup(lists: LX.List.UserListInfo[], profiles: Record<string, LX.List.UserListProfile>, id: string, offset: number): string[]
