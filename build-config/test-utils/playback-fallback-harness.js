const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const playbackError = (scope, kind, apiId) => Object.assign(new Error(kind), {
  name: 'PlaybackSourceError', scope, kind, apiId,
})

const onlineMusic = {
  id: 'song', source: 'wy', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', _qualitys: { '128k': {}, '320k': {}, flac: {} } },
}
const matchedTx = { ...onlineMusic, id: 'song-tx', source: 'tx' }
const matchedKg = { ...onlineMusic, id: 'song-kg', source: 'kg' }
const flacMusic = onlineMusic
const no128Music = { ...onlineMusic, id: 'no-128', meta: { ...onlineMusic.meta, _qualitys: { flac: {} } } }
const localMusic = {
  id: 'local-song', source: 'local', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', filePath: 'C:\\Music\\Song.mp3', _qualitys: {} },
}
const webdavMusic = {
  id: 'webdav-song', source: 'webdav', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', filePath: '/Song.mp3', _qualitys: {} },
}
const downloadItem = {
  id: 'download-song', progress: 0, status: 'run',
  metadata: { musicInfo: onlineMusic, quality: '320k' },
}
const song = onlineMusic
const songA = onlineMusic
const songB = { ...onlineMusic, id: 'song-b' }

const createFakeClock = (start = 0) => {
  let now = start
  let sequence = 0
  const timers = new Map()
  const clock = {
    now: () => now,
    setTimeout(handler, delay) {
      const id = ++sequence
      timers.set(id, { id, deadline: now + Math.max(0, delay), handler })
      return id
    },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      now += ms
      while (true) {
        const due = [...timers.values()]
          .filter(timer => timer.deadline <= now)
          .sort((a, b) => a.deadline - b.deadline || a.id - b.id)[0]
        if (!due) break
        timers.delete(due.id)
        due.handler()
      }
    },
    setNow(value) {
      if (value < now) throw new RangeError('fake clock cannot move backwards')
      now = value
    },
    async flush() {
      await Promise.resolve()
      await Promise.resolve()
    },
  }
  return clock
}

module.exports = {
  deferred,
  playbackError,
  createFakeClock,
  onlineMusic,
  matchedTx,
  matchedKg,
  flacMusic,
  no128Music,
  localMusic,
  webdavMusic,
  downloadItem,
  song,
  songA,
  songB,
}
