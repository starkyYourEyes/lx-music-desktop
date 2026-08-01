import musicSdk from '@renderer/utils/musicSdk'
import { toNewMusicInfo } from '@renderer/utils'

export interface OnlineCandidateProvider {
  getOriginal: () => LX.Music.MusicInfoOnline
  getMatched: (supported?: ReadonlySet<LX.OnlineSource>) => Promise<LX.Music.MusicInfoOnline[]>
}

export interface CandidateSearchQuery {
  name: string
  singer: string
  source: string
  albumName: string
  interval: string
}

export type FindPlaybackCandidates = (
  query: CandidateSearchQuery,
) => Promise<LX.Music.MusicInfoOnline[]>

export const findPlaybackCandidates: FindPlaybackCandidates = async query => (
  (await musicSdk.findMusic(query)).map(toNewMusicInfo) as LX.Music.MusicInfoOnline[]
)

export const buildSearchQuery = (
  musicInfo: LX.Music.MusicInfo,
  override: Partial<Pick<CandidateSearchQuery, 'name' | 'singer'>> = {},
): CandidateSearchQuery => ({
  name: override.name ?? musicInfo.name,
  singer: override.singer ?? musicInfo.singer,
  source: musicInfo.source,
  albumName: musicInfo.meta.albumName,
  interval: musicInfo.interval ?? '',
})

export const createOnlineCandidateProvider = (
  musicInfo: LX.Music.MusicInfoOnline,
  findMusic: FindPlaybackCandidates,
): OnlineCandidateProvider => {
  let matchedPromise: Promise<LX.Music.MusicInfoOnline[]> | null = null
  const getAllMatched = async() => matchedPromise ??= findMusic(buildSearchQuery(musicInfo))
  return {
    getOriginal: () => musicInfo,
    async getMatched(supported) {
      const matched = await getAllMatched()
      return supported ? matched.filter(item => supported.has(item.source)) : matched
    },
  }
}

export interface LocalCandidateProvider {
  readonly batchCount: number
  getBatch: (index: number) => Promise<LX.Music.MusicInfoOnline[]>
}

export const createLocalCandidateProvider = (
  musicInfo: LX.Music.MusicInfoLocal,
  findMusic: FindPlaybackCandidates,
): LocalCandidateProvider => {
  const queryFactories: Array<() => CandidateSearchQuery> = [
    () => buildSearchQuery(musicInfo),
  ]
  if (musicInfo.name.includes('-')) {
    const [name, singer] = musicInfo.name.split('-').map(value => value.trim())
    queryFactories.push(
      () => buildSearchQuery(musicInfo, { name, singer }),
      () => buildSearchQuery(musicInfo, { name: singer, singer: name }),
    )
  }
  const pathName = musicInfo.meta.filePath.split(/\/|\\/).at(-1) ?? ''
  const dotIndex = pathName.lastIndexOf('.')
  const fileName = dotIndex > 0 ? pathName.substring(0, dotIndex) : pathName
  if (fileName && fileName != musicInfo.name) {
    if (fileName.includes('-')) {
      const [name, singer] = fileName.split('-').map(value => value.trim())
      queryFactories.push(
        () => buildSearchQuery(musicInfo, { name, singer }),
        () => buildSearchQuery(musicInfo, { name: singer, singer: name }),
      )
    } else {
      queryFactories.push(() => buildSearchQuery(musicInfo, { name: fileName, singer: '' }))
    }
  }
  const batchPromises = new Map<number, Promise<LX.Music.MusicInfoOnline[]>>()
  return {
    batchCount: queryFactories.length,
    // Keep the exact cached promise identity for each independently ranked batch.
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    getBatch(index) {
      const query = queryFactories[index]
      if (!query) return Promise.resolve([])
      let promise = batchPromises.get(index)
      if (!promise) {
        promise = findMusic(query())
        batchPromises.set(index, promise)
      }
      return promise
    },
  }
}

const HIGH_TO_LOW: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

export const selectPlaybackQuality = (
  requested: LX.Quality,
  musicInfo: LX.Music.MusicInfoOnline,
  supportedQualities: readonly LX.Quality[],
): LX.Quality | null => {
  const requestedIndex = HIGH_TO_LOW.indexOf(requested)
  const allowed: LX.Quality[] = requestedIndex < 0 ? [requested, '128k'] : HIGH_TO_LOW.slice(requestedIndex)
  return allowed.find(quality => (
    musicInfo.meta._qualitys[quality] && supportedQualities.includes(quality)
  )) ?? null
}
