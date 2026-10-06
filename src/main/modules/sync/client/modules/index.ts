import * as list from './list'
import * as dislike from './dislike'
import * as party from './party'
import * as userApi from './userApi'
import * as listProfile from './listProfile'
// export * as theme from './theme'


export const callObj = Object.assign({},
  list.handler,
  dislike.handler,
  party.handler,
  userApi.handler,
  listProfile.handler,
)


export const modules = {
  list,
  dislike,
  party,
  userApi,
  listProfile,
}

export const featureVersion = {
  list: 1,
  dislike: 1,
  party: 1,
  userApi: 2,
  listProfile: 1,
} as const
