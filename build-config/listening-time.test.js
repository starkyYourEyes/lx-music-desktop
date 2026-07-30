const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('listening time statistics', async() => {
  const {
    addListeningTime,
    createDefaultListeningTimeStats,
    normalizeListeningTimeStats,
  } = await import('../src/common/utils/listeningTime.ts')

  it('accumulates sub-second playback updates and records the song', () => {
    const stats = createDefaultListeningTimeStats()
    const date = new Date(2026, 6, 29, 12)
    const song = {
      id: 'song-1',
      name: 'Test Song',
      singer: 'Test Singer',
      source: 'test',
    }

    for (let index = 0; index < 8; index++) {
      addListeningTime(stats, 0.25, song, date)
    }

    assert.equal(stats.totalSeconds, 2)
    assert.equal(stats.daily['2026-07-29'], 2)
    assert.equal(stats.songs['test:song-1'].seconds, 2)
    assert.equal(Object.keys(stats.songs).length, 1)
  })

  it('preserves partial seconds when persisted statistics are loaded', () => {
    const stats = normalizeListeningTimeStats({
      totalSeconds: 1.75,
      daily: {
        '2026-07-29': 1.75,
      },
      songs: {
        'test:song-1': {
          id: 'song-1',
          name: 'Test Song',
          singer: 'Test Singer',
          source: 'test',
          seconds: 1.75,
        },
      },
      updatedAt: 123,
    })

    assert.equal(stats.totalSeconds, 1.75)
    assert.equal(stats.daily['2026-07-29'], 1.75)
    assert.equal(stats.songs['test:song-1'].seconds, 1.75)
  })
})
