const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('listening time statistics', async() => {
  const {
    addListeningTime,
    buildListeningWeekRows,
    createDefaultListeningTimeStats,
    normalizeListeningTimeStats,
    rankTracksByPlayCount,
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

  it('builds seven chronological horizontal rows with explicit durations', () => {
    const now = new Date(2026, 8, 1, 23, 45)
    const rows = buildListeningWeekRows([
      { localDay: '2026-08-29', playedMs: 45000 },
      { localDay: '2026-08-30', playedMs: 90000 },
    ], now)

    assert.equal(rows.length, 7)
    assert.deepEqual(rows.map(row => row.key), [
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
    ])
    assert.equal(rows[0].label, '周三 8/26')
    assert.equal(rows.at(-1).label, '今天 9/1')
    assert.deepEqual(
      rows.slice(3, 5).map(row => [row.width, row.duration]),
      [[50, '45秒'], [100, '1分钟30秒']],
    )
    assert.deepEqual(
      rows.at(-1),
      { key: '2026-09-01', label: '今天 9/1', duration: '0秒', width: 0 },
    )
    assert.deepEqual(
      rows[1],
      { key: '2026-08-27', label: '周四 8/27', duration: '0秒', width: 0 },
    )
    assert.equal(now.getHours(), 23)
  })

  it('ranks at most 100 positive play counts without mutating the input', () => {
    const tracks = Array.from({ length: 105 }, (_, index) => ({
      source: 'test',
      sourceTrackId: String(index),
      name: `Track ${index}`,
      singer: 'Singer',
      playCount: index == 0 ? 0 : index,
    }))
    const original = [...tracks]

    const ranked = rankTracksByPlayCount(tracks, 500)

    assert.equal(ranked.length, 100)
    assert.equal(ranked[0].playCount, 104)
    assert.equal(ranked.at(-1).playCount, 5)
    assert.deepEqual(ranked.map(track => track.rank), Array.from({ length: 100 }, (_, index) => index + 1))
    assert.deepEqual(tracks, original)
    assert.equal(ranked.some(track => track.playCount == 0), false)
  })

  it('uses a stable identity-derived tie order and keeps cross-source tracks separate', () => {
    const tracks = [
      { source: 'source-a', sourceTrackId: 'same', name: 'A', singer: '', playCount: 3 },
      { source: 'source-b', sourceTrackId: 'same', name: 'B', singer: '', playCount: 3 },
      { source: 'source-a', sourceTrackId: 'other', name: 'C', singer: '', playCount: 3 },
    ]
    const forward = rankTracksByPlayCount(tracks)
    const reversed = rankTracksByPlayCount([...tracks].reverse())

    assert.deepEqual(forward.map(track => track.key), reversed.map(track => track.key))
    assert.equal(new Set(forward.map(track => track.key)).size, 3)
    assert.equal(forward.filter(track => track.sourceTrackId == 'same').length, 2)
  })
})
