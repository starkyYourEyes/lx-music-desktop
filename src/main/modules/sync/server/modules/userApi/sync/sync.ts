export const sync = async(socket: LX.Sync.Server.Socket) => {
  if (!socket.feature.userApi) throw new Error('userApi feature options not available')

  await socket.remoteQueueUserApi.user_api_sync_finished()
  socket.moduleReadys.userApi = true
}
