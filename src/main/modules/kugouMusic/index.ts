import { createKugouAccountService } from './account'
import { createKugouApiClient } from './api'
import { createKugouRecommendationService, KugouAuthError } from './recommend'
import { createKugouUserPlaylistService } from './userPlaylists'

export { createKugouAccountService }

let accountService: ReturnType<typeof createKugouAccountService> | undefined
let recommendationService: ReturnType<typeof createKugouRecommendationService> | undefined
let userPlaylistService: ReturnType<typeof createKugouUserPlaylistService> | undefined
const getAccountService = () => {
  if (accountService) return accountService
  const accounts = global.lx.accountRepository
  if (!accounts) throw new Error('Account repository has not been initialized')
  accountService = createKugouAccountService({ accounts, api: createKugouApiClient() })
  return accountService
}

export const getAccountStatus = async() => getAccountService().getAccountStatus()
export const createLoginQr = async(requestId: string) => getAccountService().createLoginQr(requestId)
export const checkLoginQr = async(requestId: string) => getAccountService().checkLoginQr(requestId)
export const cancelLoginQr = async(requestId: string) => getAccountService().cancelLoginQr(requestId)
export const logout = async() => getAccountService().logout()
const getUserPlaylistService = () => {
  if (userPlaylistService) return userPlaylistService
  const account = getAccountService()
  userPlaylistService = createKugouUserPlaylistService({
    api: createKugouApiClient(),
    getCookie: account.getCookie,
    getProfile: account.getProfile,
    onAuthFailure: account.logout,
  })
  return userPlaylistService
}
export const getKugouUserPlaylists = async(kinds?: readonly LX.PlatformPlaylistKind[]): Promise<LX.PlatformPlaylistSummary[]> => {
  return getUserPlaylistService().getUserPlaylists(kinds)
}
const getRecommendationService = () => {
  if (recommendationService) return recommendationService
  const accounts = global.lx.accountRepository
  if (!accounts) throw new Error('Account repository has not been initialized')
  recommendationService = createKugouRecommendationService({
    api: createKugouApiClient(),
    getCookie: () => accounts.getCookie('kugou') ?? '',
    onAuthFailure: async() => getAccountService().logout(),
  })
  return recommendationService
}
export const getPublicRecommendation = async() => getRecommendationService().getPublicRecommendation()
export const getDailyRecommendSongs = async() => getRecommendationService().getDailyRecommendSongs()
export const getStyleRecommendation = async() => getRecommendationService().getStyleRecommendation()
export const getPrivateFmSongs = async() => getRecommendationService().getPrivateFmSongs()
export const getPrivateFm = getPrivateFmSongs
export const getRankRecommendation = async() => getRecommendationService().getRankRecommendation()
export { createKugouApiClient }
export { createKugouRecommendationService, KugouAuthError }
