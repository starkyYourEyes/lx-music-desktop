import { sync as listSync } from './list'
import { sync as dislikeSync } from './dislike'
import { sync as userApiSync } from './userApi'
import * as listProfile from './listProfile'

export const callObj = Object.assign({},
  listSync.handler,
  dislikeSync.handler,
  userApiSync.handler,
  listProfile.handler,
)

export const modules = {
  list: listSync,
  dislike: dislikeSync,
  userApi: userApiSync,
  listProfile,
}


export { ListManage } from './list'

export { DislikeManage } from './dislike'

export const featureVersion = {
  list: 1,
  dislike: 1,
  userApi: 2,
  listProfile: 1,
} as const
