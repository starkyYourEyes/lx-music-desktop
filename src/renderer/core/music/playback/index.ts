import { encodePath, log } from '@common/utils'
import { appSetting } from '@renderer/store/setting'
import { buildSavePath } from '@renderer/store/download/utils'
import { getDownloadFilePath, getLocalFilePath } from '@renderer/utils/music'
import { getMusicUrl as getWebDAVMusicUrl } from '../webdav'
import { clearResourceIf } from '@renderer/plugins/player'
import {
  observePlaybackCachePersistence,
  playbackUrlCache,
  type PlaybackCachePersistenceFailure,
  type PlaybackUrlCache,
} from './cache'
import {
  createLocalCandidateProvider,
  createOnlineCandidateProvider,
  findPlaybackCandidates,
  type LocalCandidateProvider,
  type OnlineCandidateProvider,
} from './candidates'
import {
  createPlaybackResolutionCoordinator,
  getPlaybackSongIdentity,
  type CreatePlaybackRequest,
} from './coordinator'
import {
  createPlaybackResolveSession,
  type CreatePlaybackResolveSession,
  type CreatePlaybackResolveSessionOptions,
  type PlaybackClock,
  type PlaybackResolveSession,
} from './session'
import { playbackSourceAdapter, type PlaybackSourceAdapter } from './sourceAdapter'

export interface PlaybackSessionFactoryInput<TMusicInfo> {
  musicInfo: TMusicInfo
  policy: LX.Playback.ResolvePolicy
  cacheMode: 'lookup' | 'bypass'
}

export interface PlaybackSessionSettingSnapshot {
  primaryId: string
  fallbackIds: readonly string[]
  requestedQuality: LX.Quality
}

export interface PlaybackSessionFactoriesDependencies {
  readSettings: () => PlaybackSessionSettingSnapshot
  cache: PlaybackUrlCache
  adapter: PlaybackSourceAdapter
  clock: PlaybackClock
  createId: () => string
  diagnostics: CreatePlaybackResolveSessionOptions['diagnostics']
  reportPersistenceFailure: (value: PlaybackCachePersistenceFailure) => void
  createResolveSession: CreatePlaybackResolveSession
  createOnlineCandidateProvider: (
    musicInfo: LX.Music.MusicInfoOnline,
  ) => OnlineCandidateProvider
  createLocalCandidateProvider: (
    musicInfo: LX.Music.MusicInfoLocal,
  ) => LocalCandidateProvider
}

export interface PlaybackSessionFactories {
  createOnlinePlaybackSession: (
    input: PlaybackSessionFactoryInput<LX.Music.MusicInfoOnline>,
  ) => Promise<PlaybackResolveSession>
  createLocalPlaybackSession: (
    input: PlaybackSessionFactoryInput<LX.Music.MusicInfoLocal>,
  ) => Promise<PlaybackResolveSession>
}

export type CreatePlaybackSessionFactories = (
  deps: PlaybackSessionFactoriesDependencies,
) => PlaybackSessionFactories

export interface PlaybackMusicFacadeDependencies {
  getDownloadFilePath: typeof getDownloadFilePath
  buildSavePath: typeof buildSavePath
  getLocalFilePath: typeof getLocalFilePath
  encodePath: typeof encodePath
  getWebDAVMusicUrl: typeof getWebDAVMusicUrl
  createOnlinePlaybackSession: PlaybackSessionFactories['createOnlinePlaybackSession']
  createLocalPlaybackSession: PlaybackSessionFactories['createLocalPlaybackSession']
}

export interface PlaybackMusicFacade {
  resolvePolicyForReason: typeof resolvePolicyForReason
  createPlaybackRequest: CreatePlaybackRequest
}

export type CreatePlaybackMusicFacade = (
  deps: PlaybackMusicFacadeDependencies,
) => PlaybackMusicFacade

export const resolvePolicyForReason = (
  reason: LX.Playback.ResolveReason,
): { policy: LX.Playback.ResolvePolicy, cacheMode: 'lookup' | 'bypass' } => {
  switch (reason) {
    case 'postCommitError': return { policy: 'primaryOnly', cacheMode: 'bypass' }
    case 'forceRefresh': return { policy: 'fallback', cacheMode: 'bypass' }
    case 'initial':
    case 'preload': return { policy: 'fallback', cacheMode: 'lookup' }
  }
}

export const createPlaybackSessionFactories: CreatePlaybackSessionFactories = deps => {
  const createSession = async(
    musicInfo: LX.Music.MusicInfoOnline | LX.Music.MusicInfoLocal,
    policy: LX.Playback.ResolvePolicy,
    cacheMode: 'lookup' | 'bypass',
    candidateProvider: OnlineCandidateProvider | LocalCandidateProvider,
  ): Promise<PlaybackResolveSession> => {
    const setting = deps.readSettings()
    const requestedQuality = setting.requestedQuality
    const sourceIds = policy == 'primaryOnly'
      ? [setting.primaryId]
      : [setting.primaryId, ...setting.fallbackIds]
    if (cacheMode == 'bypass' && policy == 'fallback') {
      let invalidation: Promise<void>
      try {
        invalidation = Promise.resolve().then(async() => {
          if (musicInfo.source == 'local') return
          const key = await deps.adapter.authorizeMusicUrl({
            apiId: setting.primaryId,
            musicInfo,
            quality: requestedQuality,
            signal: new AbortController().signal,
          })
          if (key != null) await deps.cache.invalidateQualityRange(key)
        })
      } catch (error) {
        invalidation = Promise.reject(error)
      }
      await observePlaybackCachePersistence(
        invalidation,
        'delete',
        deps.reportPersistenceFailure,
      )
    }
    return deps.createResolveSession({
      musicInfo,
      sourceIds,
      requestedQuality,
      cacheMode,
      adapter: deps.adapter,
      cache: deps.cache,
      candidateProvider,
      clock: deps.clock,
      createId: deps.createId,
      diagnostics: deps.diagnostics,
      reportPersistenceFailure: deps.reportPersistenceFailure,
    })
  }

  return {
    createOnlinePlaybackSession: async({ musicInfo, policy, cacheMode }) => createSession(
      musicInfo, policy, cacheMode, deps.createOnlineCandidateProvider(musicInfo),
    ),
    createLocalPlaybackSession: async({ musicInfo, policy, cacheMode }) => createSession(
      musicInfo, policy, cacheMode, deps.createLocalCandidateProvider(musicInfo),
    ),
  }
}

export const createPlaybackMusicFacade: CreatePlaybackMusicFacade = deps => {
  const createPlaybackRequest: CreatePlaybackRequest = async({ musicInfo, reason }) => {
    const songIdentity = getPlaybackSongIdentity(musicInfo)
    const { policy, cacheMode } = resolvePolicyForReason(reason)
    if ('progress' in musicInfo) {
      const path = await deps.getDownloadFilePath(musicInfo, deps.buildSavePath(musicInfo))
      return path
        ? {
            kind: 'direct',
            resource: {
              kind: 'direct',
              songIdentity,
              url: deps.encodePath(path),
              reportedQuality: musicInfo.metadata.quality,
            },
          }
        : {
            kind: 'session',
            session: await deps.createOnlinePlaybackSession({
              musicInfo: musicInfo.metadata.musicInfo,
              policy,
              cacheMode,
            }),
          }
    }
    if (musicInfo.source == 'webdav') {
      return {
        kind: 'direct',
        resource: {
          kind: 'direct',
          songIdentity,
          url: await deps.getWebDAVMusicUrl({ musicInfo, isRefresh: reason != 'initial' }),
        },
      }
    }
    if (musicInfo.source == 'local') {
      const path = await deps.getLocalFilePath(musicInfo)
      return path
        ? { kind: 'direct', resource: { kind: 'direct', songIdentity, url: deps.encodePath(path) } }
        : {
            kind: 'session',
            session: await deps.createLocalPlaybackSession({
              musicInfo,
              policy,
              cacheMode,
            }),
          }
    }
    return {
      kind: 'session',
      session: await deps.createOnlinePlaybackSession({ musicInfo, policy, cacheMode }),
    }
  }
  return { resolvePolicyForReason, createPlaybackRequest }
}

const playbackClock: PlaybackClock = {
  now: Date.now,
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
}

const playbackSessionFactories = createPlaybackSessionFactories({
  readSettings: () => ({
    primaryId: appSetting['common.apiSource'],
    fallbackIds: [...appSetting['common.apiFallbackSources']],
    requestedQuality: appSetting['player.playQuality'],
  }),
  cache: playbackUrlCache,
  adapter: playbackSourceAdapter,
  clock: playbackClock,
  createId: () => crypto.randomUUID(),
  diagnostics: { record: value => log.debug('playback source attempt', value) },
  reportPersistenceFailure: value => log.error('playback cache persistence failure', value),
  createResolveSession: createPlaybackResolveSession,
  createOnlineCandidateProvider: musicInfo => createOnlineCandidateProvider(
    musicInfo,
    findPlaybackCandidates,
  ),
  createLocalCandidateProvider: musicInfo => createLocalCandidateProvider(
    musicInfo,
    findPlaybackCandidates,
  ),
})

const playbackMusicFacade = createPlaybackMusicFacade({
  getDownloadFilePath,
  buildSavePath,
  getLocalFilePath,
  encodePath,
  getWebDAVMusicUrl,
  createOnlinePlaybackSession: playbackSessionFactories.createOnlinePlaybackSession,
  createLocalPlaybackSession: playbackSessionFactories.createLocalPlaybackSession,
})

export const createPlaybackRequest = playbackMusicFacade.createPlaybackRequest

export const playbackResolutionCoordinator = createPlaybackResolutionCoordinator({
  createRequest: createPlaybackRequest,
  createPreloadAudio: () => {
    const audio = new Audio()
    audio.muted = true
    audio.preload = 'auto'
    audio.crossOrigin = 'anonymous'
    return audio
  },
  detachForegroundResource: clearResourceIf,
  clock: playbackClock,
})

export { createPlaybackResolutionCoordinator, getPlaybackSongIdentity } from './coordinator'
export type {
  CandidatePlaybackResource,
  ForegroundPlaybackRequestInput,
  DirectPlaybackResource,
  ForegroundCanplayResult,
  ForegroundResolutionHandlers,
  PlaybackRequestResult,
  PlaybackResolutionCoordinator,
  PlaybackResolutionCoordinatorDependencies,
  PlaybackResource,
  ValidatedPlaybackResource,
} from './coordinator'
export { createPlaybackResolveSession } from './session'
export type {
  CreatePlaybackResolveSession,
  CreatePlaybackResolveSessionOptions,
  ForegroundCancelReason,
  PlaybackClock,
  PlaybackResolveSession,
  PreloadCancelReason,
} from './session'
