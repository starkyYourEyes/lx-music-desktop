import { log } from '@common/utils'
import { onBeforeUnmount } from '@common/utils/vueTools'
import {
  onSeeking,
  onSeeked,
  onRatechange,
  getErrorCode,
  onEmptied,
  onEnded,
  onPause,
  onPlaying,
  playerResourceController,
  type PlayerResourceController,
  type ResourceMediaEvent,
} from '@renderer/plugins/player'
import {
  playbackResolutionCoordinator,
  type PlaybackResolutionCoordinator,
} from '@renderer/core/music/playback'
import {
  observePlaybackCachePersistence,
  playbackUrlCache,
  type PlaybackCachePersistenceFailure,
  type PlaybackUrlCache,
} from '@renderer/core/music/playback/cache'
import { setLoadedMusicIdentity } from '@renderer/core/player'
import { currentPlaybackQuality } from '@renderer/store/player/state'

export interface PlayerMediaEventHandlers {
  canplay: (event: ResourceMediaEvent) => void
  error: (event: ResourceMediaEvent) => void
  loadstart: (event: ResourceMediaEvent) => void
  loadeddata: (event: ResourceMediaEvent) => void
  waiting: (event: ResourceMediaEvent) => void
}

export type CreatePlayerMediaEventHandlers = (deps: {
  resource: PlayerResourceController
  coordinator: PlaybackResolutionCoordinator
  cache: PlaybackUrlCache
  getErrorCode: () => number | undefined
  setLoadedMusicIdentity: (identity: string) => void
  setPlaybackQuality: (value: LX.Quality | null) => void
  appEvent: Pick<typeof window.app_event,
  'error' | 'playerError' | 'playerCanplay' | 'playerLoadstart' |
  'playerLoadeddata' | 'playerWaiting'>
  reportPersistenceFailure: (value: PlaybackCachePersistenceFailure) => void
}) => PlayerMediaEventHandlers

export const createPlayerMediaEventHandlers: CreatePlayerMediaEventHandlers = deps => ({
  error({ resource, currentSrc }) {
    if (!deps.resource.isCurrentResourceEvent(resource, currentSrc)) return
    deps.setPlaybackQuality(null)
    if (resource.kind == 'candidate') {
      deps.coordinator.handleForegroundError(resource)
      return
    }
    if (resource.kind == 'validated' && resource.cacheKey) {
      void observePlaybackCachePersistence(
        deps.cache.tombstoneKey(resource.cacheKey),
        'delete',
        deps.reportPersistenceFailure,
      )
    }
    const errorCode = deps.getErrorCode()
    deps.appEvent.error(errorCode)
    deps.appEvent.playerError(errorCode)
  },
  canplay({ resource, currentSrc }) {
    if (!deps.resource.isCurrentResourceEvent(resource, currentSrc)) return
    let acceptedResource = resource
    if (resource.kind == 'candidate') {
      const result = deps.coordinator.handleForegroundCanplay(resource)
      if (result.status != 'accepted') return
      if (!deps.resource.replaceResourceContext(resource, result.resource)) return
      acceptedResource = { ...result.resource, resourceGeneration: resource.resourceGeneration }
      deps.appEvent.playerLoadeddata()
    }
    deps.setLoadedMusicIdentity(acceptedResource.songIdentity)
    deps.setPlaybackQuality(acceptedResource.reportedQuality ?? null)
    deps.appEvent.playerCanplay()
  },
  loadstart({ resource, currentSrc }) {
    if (!deps.resource.isCurrentResourceEvent(resource, currentSrc) || resource.kind == 'candidate') return
    deps.appEvent.playerLoadstart()
  },
  loadeddata({ resource, currentSrc }) {
    if (!deps.resource.isCurrentResourceEvent(resource, currentSrc) || resource.kind == 'candidate') return
    deps.appEvent.playerLoadeddata()
  },
  waiting({ resource, currentSrc }) {
    if (!deps.resource.isCurrentResourceEvent(resource, currentSrc) || resource.kind == 'candidate') return
    deps.appEvent.playerWaiting()
  },
})

export default () => {
  const handlers = createPlayerMediaEventHandlers({
    resource: playerResourceController,
    coordinator: playbackResolutionCoordinator,
    cache: playbackUrlCache,
    getErrorCode,
    setLoadedMusicIdentity,
    setPlaybackQuality: value => { currentPlaybackQuality.value = value },
    appEvent: window.app_event,
    reportPersistenceFailure: value => log.error('playback cache persistence failure', value),
  })
  const disposeResourceEvents = [
    playerResourceController.onCanplay(handlers.canplay),
    playerResourceController.onError(handlers.error),
    playerResourceController.onLoadstart(handlers.loadstart),
    playerResourceController.onLoadeddata(handlers.loadeddata),
    playerResourceController.onWaiting(handlers.waiting),
  ]
  const disposeRawEvents = [
    onPlaying(() => {
      window.app_event.playerPlaying()
      window.app_event.play()
    }),
    onPause(() => {
      window.app_event.playerPause()
      window.app_event.pause()
    }),
    onEnded(() => window.app_event.playerEnded()),
    onEmptied(() => window.app_event.playerEmptied()),
    onSeeking(() => window.app_event.playerSeeking()),
    onSeeked(() => window.app_event.playerSeeked()),
    onRatechange(() => window.app_event.playerRatechange()),
  ]

  onBeforeUnmount(() => {
    for (const dispose of [...disposeResourceEvents, ...disposeRawEvents]) dispose()
  })
}
