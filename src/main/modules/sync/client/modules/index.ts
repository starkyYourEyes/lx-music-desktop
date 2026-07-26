import * as list from './list'
import * as dislike from './dislike'
import * as party from './party'
import * as userApi from './userApi'
// export * as theme from './theme'


export const callObj = Object.assign({},
  list.handler,
  dislike.handler,
  party.handler,
  userApi.handler,
)


export const modules = {
  list,
  dislike,
  party,
  userApi,
}

export const featureVersion = {
  list: 1,
  dislike: 1,
  party: 1,
  userApi: 2,
} as const
