// 这个文件导出的方法将暴露给客户端调用，第一个参数固定为当前 socket 对象
// import { getUserSpace } from '@/user'
import { modules } from '../../modules'

const handler: LX.Sync.ServerSyncHandlerActions<LX.Sync.Server.Socket> = {
  async onFeatureChanged(socket, feature) {
    // const userSpace = getUserSpace(socket.userInfo.name)
    const beforeFeature = socket.feature
    const isProfileChangeCurrent = feature.listProfile != null || feature.list != null
      ? modules.listProfile.invalidate(socket)
      : undefined
    if (feature.listProfile != null) beforeFeature.listProfile = feature.listProfile
    if (feature.list != null) {
      socket.moduleReadys.listProfile = false
      beforeFeature.list = feature.list
      socket.moduleReadys.list = false
      if (feature.list) await modules.list.sync(socket).catch(_ => _)
    }

    if (isProfileChangeCurrent?.()) {
      socket.moduleReadys.listProfile = false
      if (beforeFeature.listProfile && socket.moduleReadys.list) await modules.listProfile.sync(socket)
    }

    if (feature.dislike != null) {
      beforeFeature.dislike = feature.dislike
      socket.moduleReadys.dislike = false
      if (feature.dislike) await modules.dislike.sync(socket).catch(_ => _)
    }

    if (feature.userApi != null) {
      beforeFeature.userApi = feature.userApi
      socket.moduleReadys.userApi = false
      if (feature.userApi) await modules.userApi.sync(socket).catch(_ => _)
    }
  },
}

export default handler
