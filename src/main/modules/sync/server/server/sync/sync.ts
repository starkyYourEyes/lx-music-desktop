import { featureVersion, modules } from '../../modules'


export const sync = async(socket: LX.Sync.Server.Socket) => {
  let disconnected = false
  socket.onClose(() => {
    disconnected = true
  })
  const enabledFeatures = await socket.remote.getEnabledFeatures('desktop-app', featureVersion)

  if (disconnected) throw new Error('disconnected')
  if (enabledFeatures.list) {
    socket.feature.list = enabledFeatures.list
    await modules.list.sync(socket).catch(_ => _)
  }
  if (disconnected) throw new Error('disconnected')
  if (enabledFeatures.dislike) {
    socket.feature.dislike = enabledFeatures.dislike
    await modules.dislike.sync(socket).catch(_ => _)
  }
  if (disconnected) throw new Error('disconnected')
  if (enabledFeatures.userApi) {
    socket.feature.userApi = enabledFeatures.userApi
    await modules.userApi.sync(socket).catch(_ => _)
  }
  if (disconnected) throw new Error('disconnected')
  await socket.remote.finished()
}
