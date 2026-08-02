import { type workerDBSeriveTypes } from '@main/worker/dbService'

declare global {
  // interface WorkerDBSeriveTypes {
  //   list: typeof list
  // }
  namespace LX {
    type WorkerDBServiceTypes = workerDBSeriveTypes
    type WorkerDBSeriveListTypes = WorkerDBServiceTypes
  }
}
