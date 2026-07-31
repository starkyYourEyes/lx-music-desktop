import type { PlaybackDayBoundary } from './types'

interface LocalDayBoundaryInput {
  afterMs: number
  timeZone: string
}

const partsFor = (epochMs: number, timeZone: string): Record<string, number> => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return Object.fromEntries(formatter.formatToParts(epochMs)
    .filter(part => part.type != 'literal')
    .map(part => [part.type, Number(part.value)]))
}

const localDate = (epochMs: number, timeZone: string): [number, number, number] => {
  const parts = partsFor(epochMs, timeZone)
  return [parts.year, parts.month, parts.day]
}

const offsetAt = (epochMs: number, timeZone: string): number => {
  const parts = partsFor(epochMs, timeZone)
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epochMs) / 60000
}

const formatDay = (year: number, month: number, day: number): string => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const dateValue = ([year, month, day]: [number, number, number]): number => Date.UTC(year, month - 1, day)

export const nextLocalDayBoundary = ({ afterMs, timeZone }: LocalDayBoundaryInput): PlaybackDayBoundary => {
  const [year, month, day] = localDate(afterMs, timeZone)
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1))
  const nextYear = nextDate.getUTCFullYear()
  const nextMonth = nextDate.getUTCMonth() + 1
  const nextDay = nextDate.getUTCDate()
  const targetDate = Date.UTC(nextYear, nextMonth - 1, nextDay)
  let low = targetDate - 36 * 60 * 60 * 1000
  let high = targetDate + 36 * 60 * 60 * 1000
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if (dateValue(localDate(middle, timeZone)) < targetDate) low = middle + 1
    else high = middle
  }
  const occurredAtMs = low

  return {
    occurredAtMs,
    nextLocalDay: formatDay(nextYear, nextMonth, nextDay),
    utcOffsetMinutes: offsetAt(occurredAtMs, timeZone),
  }
}
