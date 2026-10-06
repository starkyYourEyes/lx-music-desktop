interface RestartDependencies {
  flush: () => Promise<void>
  relaunch: () => void
  quit: () => void
}

export const createAppRestart = (dependencies: RestartDependencies) => {
  let pending: Promise<void> | null = null
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Async wrapping would break the shared in-flight Promise identity.
  return (): Promise<void> => {
    pending ??= Promise.resolve().then(async() => {
      await dependencies.flush()
      dependencies.relaunch()
      dependencies.quit()
    }).catch(error => {
      pending = null
      throw error
    })
    return pending
  }
}
