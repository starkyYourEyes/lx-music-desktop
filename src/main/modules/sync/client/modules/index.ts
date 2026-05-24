import * as list from './list'
import * as dislike from './dislike'
import * as party from './party'
// export * as theme from './theme'


export const callObj = Object.assign({},
  list.handler,
  dislike.handler,
  party.handler,
)


export const modules = {
  list,
  dislike,
  party,
}

export const featureVersion = {
  list: 1,
  dislike: 1,
  party: 1,
} as const
