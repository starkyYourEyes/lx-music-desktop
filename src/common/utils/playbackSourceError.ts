export const createPlaybackSourceError = (
  data: Omit<LX.Playback.SourceFailureData, 'name'> & { cause?: unknown },
): LX.Playback.SourceError => {
  const { cause, ...failure } = data
  const complete = { name: 'PlaybackSourceError' as const, ...failure }
  const error = Object.assign(new Error(complete.message), complete) as LX.Playback.SourceError
  if (cause !== undefined) error.cause = cause
  return error
}

export const toPlaybackSourceError = (data: LX.Playback.SourceFailureData): LX.Playback.SourceError => {
  const { name: _name, ...rest } = data
  return createPlaybackSourceError(rest)
}

export const isPlaybackSourceError = (value: unknown): value is LX.Playback.SourceError => {
  if (!(value instanceof Error) || value.name != 'PlaybackSourceError') return false
  const candidate = value as Partial<LX.Playback.SourceError>
  return typeof candidate.message == 'string' &&
    ['candidate', 'source', 'session'].includes(candidate.scope ?? '') &&
    typeof candidate.kind == 'string'
}
