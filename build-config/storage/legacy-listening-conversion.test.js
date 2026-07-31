const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('legacy listening conversion', async() => {
  const { convertLegacyListeningStats } = await import('../../src/common/storage/legacyListening.ts')

  it('rounds fractional seconds to the nearest millisecond', () => {
    const result = convertLegacyListeningStats({
      totalSeconds: 1.2346,
      daily: { '2026-07-29': 0.3335 },
      songs: {
        'test:one': { id: 'one', source: 'test', name: 'One', singer: 'Singer', seconds: 0.9004 },
      },
      updatedAt: 9,
    })

    assert.equal(result.totalPlayedMs, 1235)
    assert.equal(result.daily[0].baselinePlayedMs, 334)
    assert.equal(result.tracks[0].baselinePlayedMs, 900)
    assert.equal(result.baselineActiveTimeKnown, false)
  })

  it('preserves inconsistent aggregates instead of reconciling them', () => {
    const result = convertLegacyListeningStats({
      totalSeconds: 100,
      daily: { '2026-07-29': 80 },
      songs: { 'x:1': { id: '1', source: 'x', name: 'N', singer: 'S', seconds: 70 } },
    })

    assert.deepEqual(result.mismatch, { totalVsDailyMs: 20000, totalVsTracksMs: 30000 })
  })

  it('keeps only real calendar dates, including leap days', () => {
    const result = convertLegacyListeningStats({
      totalSeconds: 7,
      daily: {
        '2024-02-29': 2,
        '2023-02-29': 3,
        '2026-04-31': 4,
        '2026-7-29': 5,
      },
      songs: {},
    })

    assert.deepEqual(result.daily, [{ localDay: '2024-02-29', baselinePlayedMs: 2000 }])
  })

  it('skips tracks with invalid or out-of-bounds fields', () => {
    const result = convertLegacyListeningStats({
      totalSeconds: 1,
      daily: {},
      songs: {
        valid: { id: 'track-1', source: 'test', name: 'One', singer: 'Singer', seconds: 1 },
        noId: { id: '', source: 'test', name: 'Two', singer: 'Singer', seconds: 2 },
        longSource: { id: 'track-3', source: 'x'.repeat(257), name: 'Three', singer: 'Singer', seconds: 3 },
        nonStringName: { id: 'track-4', source: 'test', name: 4, singer: 'Singer', seconds: 4 },
      },
    })

    assert.deepEqual(result.tracks, [{
      source: 'test',
      sourceTrackId: 'track-1',
      name: 'One',
      singer: 'Singer',
      baselinePlayedMs: 1000,
    }])
  })
})
