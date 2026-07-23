export const createLatestLoadCoordinator = (load: (force: boolean) => Promise<void>) => {
  let revision = 0
  let pendingRevision = 0
  let pendingForce = false
  let tail = Promise.resolve()

  const request = async(force = false) => {
    const requestRevision = ++revision
    pendingRevision = requestRevision
    pendingForce = pendingForce || force

    const result = tail.then(async() => {
      if (requestRevision != pendingRevision) return
      const nextForce = pendingForce
      pendingRevision = 0
      pendingForce = false
      await load(nextForce)
    })
    tail = result.catch(() => {})
    return result
  }

  const invalidate = () => {
    revision++
    pendingRevision = 0
    pendingForce = false
  }

  return {
    request,
    invalidate,
  }
}
