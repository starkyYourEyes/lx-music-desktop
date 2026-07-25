let userApiTaskQueue = Promise.resolve()

export const runUserApiTask = async<T>(task: () => T | Promise<T>): Promise<T> => {
  const result = userApiTaskQueue.then(task)
  userApiTaskQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
