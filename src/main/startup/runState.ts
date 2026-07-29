import path from 'node:path'
import { createAtomicJsonFile } from '../storage/atomicJsonFile'

export interface RunState {
  version: 1
  clean: boolean
  startedAtMs: number
  completedAtMs: number
}

export interface RunStateStore {
  begin(): Promise<boolean>
  markClean(): Promise<void>
}

const isTimestamp = (value: unknown): value is number => {
  return typeof value == 'number' && Number.isSafeInteger(value) && value >= 0
}

const isRunState = (value: unknown): value is RunState => {
  return value != null && typeof value == 'object' &&
    'version' in value && value.version == 1 &&
    'clean' in value && typeof value.clean == 'boolean' &&
    'startedAtMs' in value && isTimestamp(value.startedAtMs) &&
    'completedAtMs' in value && isTimestamp(value.completedAtMs)
}

export const createRunState = (options: {
  runtimeRoot: string
  now?: () => number
}): RunStateStore => {
  const now = options.now ?? Date.now
  const file = createAtomicJsonFile<RunState>({
    filePath: path.join(options.runtimeRoot, 'run-state.v1.json'),
    validate: isRunState,
  })
  let current: RunState | null = null

  const begin = async(): Promise<boolean> => {
    const previous = await file.read()
    const startedAtMs = now()
    current = {
      version: 1,
      clean: false,
      startedAtMs,
      completedAtMs: previous?.completedAtMs ?? 0,
    }
    await file.replace(current)
    return previous?.clean == true
  }

  const markClean = async(): Promise<void> => {
    const state = current ?? await file.read()
    if (state == null) return
    current = {
      ...state,
      clean: true,
      completedAtMs: now(),
    }
    await file.replace(current)
  }

  return { begin, markClean }
}
