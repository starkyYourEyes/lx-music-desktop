const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { describe, it } = require('node:test')

const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const readTree = directory => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap(entry => {
    const relative = path.join(directory, entry.name)
    if (entry.isDirectory()) return readTree(relative)
    return /\.(?:ts|js|vue|sql)$/.test(entry.name) ? [{ file: relative, text: read(relative) }] : []
  })

describe('scoped cache ownership callsites', () => {
  it('defines strict scoped DTOs and exposes only scoped worker repository APIs', () => {
    const contracts = read('src/common/storage/cache.ts')
    const worker = [
      read('src/main/worker/dbService/modules/index.ts'),
      read('src/main/worker/dbService/index.ts'),
      read('src/main/worker/dbService/modules/music_url/index.ts'),
      read('src/main/worker/dbService/modules/music_other_source/index.ts'),
      read('src/main/types/db_service.d.ts'),
      read('src/main/types/worker.d.ts'),
    ].join('\n')
    assert.match(contracts, /interface\s+MusicUrlKeyV1[\s\S]*provider[\s\S]*accountScope[\s\S]*sourceTrackId[\s\S]*quality/)
    assert.match(contracts, /interface\s+TrackIdentityV1[\s\S]*originalProvider[\s\S]*originalTrackId/)
    for (const name of ['musicUrlGet', 'musicUrlPut', 'musicUrlInvalidateAccount', 'musicUrlInvalidateSource', 'otherSourcesGet', 'otherSourcesPut']) {
      assert.match(worker, new RegExp(`\\b${name}\\b`), `${name} is not exported across the worker boundary`)
    }
    assert.doesNotMatch(worker, /\b(getMusicUrl|musicUrlSave|musicUrlRemove|musicInfoOtherSourceAdd|musicInfoOtherSourceRemove)\b/)
  })

  it('uses scoped cache IPC payloads and validates hostile renderer input before worker dispatch', () => {
    const names = read('src/common/ipcNames.ts')
    const ipc = read('src/renderer/utils/ipc.ts')
    const main = read('src/main/modules/winMain/rendererEvent/music.ts')
    assert.match(names, /music_url_get/)
    assert.match(names, /music_url_put/)
    assert.match(names, /other_sources_get/)
    assert.match(names, /other_sources_put/)
    assert.match(ipc, /MusicUrlKeyV1/)
    assert.match(ipc, /TrackIdentityV1/)
    assert.doesNotMatch(ipc, /`\$\{musicInfo\.id\}_\$\{type\}`/)
    assert.match(main, /parseMusicUrlGetInput/)
    assert.match(main, /parseMusicUrlPutInput/)
    assert.match(main, /parseOtherSourcesGetInput/)
    assert.match(main, /parseOtherSourcesPutInput/)
  })

  it('persists URLs only for validated public profiles and never assigns an identity-less scope', () => {
    const ipc = read('src/renderer/utils/ipc.ts')
    const online = read('src/renderer/core/music/online.ts')
    const local = read('src/renderer/core/music/local.ts')
    const utils = read('src/renderer/core/music/utils.ts')
    const identity = [ipc, utils, read('src/common/storage/cacheValidation.ts')].join('\n')
    assert.match(identity, /neteaseAccountScope/)
    assert.match(identity, /qqMusicAccountScope/)
    assert.match(utils, /isNeteaseLoggedIn\.value/)
    assert.match(utils, /isQQMusicLoggedIn\.value/)
    assert.match(identity, /profile-v1:/)
    assert.match([online, local, utils].join('\n'), /persistentCache/)
    assert.doesNotMatch([ipc, online, local, utils].join('\n'), /accountScope\s*:\s*['"](?:guest|anonymous|public)['"]/i)
    assert.doesNotMatch([ipc, online, local, utils].join('\n'), /(?:cookie|token|authorization).*accountScope|accountScope.*(?:cookie|token|authorization)/i)
  })

  it('captures User API URL provenance through preload/runtime and disables persistent URL caching', () => {
    const preload = read('src/main/modules/userApi/renderer/preload.js')
    const runtime = read('src/renderer/core/useApp/useInitUserApi.ts')
    const types = [read('src/common/types/user_api.d.ts'), read('src/common/types/playback_source.d.ts')].join('\n')
    assert.match(preload, /persistentCache\s*:\s*false/)
    assert.match(preload, /source\s*:\s*data\.source/)
    assert.match(runtime, /persistentCache\s*:\s*false/)
    assert.match(runtime, /source\s*:\s*res\.data\.source/)
    assert.match(types, /persistentCache\s*:\s*false/)
    assert.doesNotMatch(runtime, /accountScope\s*:\s*apiId/)
  })

  it('activates scoped alternate-source persistence around discovery', () => {
    const utils = read('src/renderer/core/music/utils.ts')
    assert.match(utils, /getOtherSourcesFromCache/)
    assert.match(utils, /putOtherSourcesInCache/)
    assert.match(utils, /originalProvider\s*:/)
    assert.match(utils, /originalTrackId\s*:/)
    assert.doesNotMatch(utils, /\/\/\s*(?:if \(!isRefresh.*getOtherSourceFromStore|if \(otherSource\.length\).*saveOtherSourceFromStore)/)
  })

  it('handles failures from best-effort background cache writes', () => {
    const writes = [
      ...read('src/renderer/core/music/online.ts').matchAll(/void\s+saveMusicUrl\([^\n]+/g),
      ...read('src/renderer/core/music/local.ts').matchAll(/void\s+saveMusicUrl\([^\n]+/g),
      ...read('src/renderer/core/music/utils.ts').matchAll(/void\s+putOtherSourcesInCache\([^\n]+/g),
    ].map(match => match[0])
    assert.equal(writes.length, 4)
    for (const write of writes) assert.match(write, /\.catch\(\(\)\s*=>\s*\{\}\)$/)
  })

  it('has no active ID-only URL or alternate-source API or authoritative cache query', () => {
    const trees = [
      ...readTree('src/renderer'),
      ...readTree('src/main/modules'),
      ...readTree('src/main/worker/dbService/modules'),
      ...readTree('src/common'),
    ]
    const active = trees
      .filter(({ file }) => !file.includes(`${path.sep}migration${path.sep}`))
      .map(({ file, text }) => `/* ${file} */\n${text}`)
      .join('\n')
    assert.doesNotMatch(active, /\bgetMusicUrl\s*=\s*\(id:\s*string\)|\bmusicUrlSave\b|\bmusicInfoOtherSourceAdd\b|\bmusicInfoOtherSourceRemove\b/)
    assert.doesNotMatch(active, /FROM\s+["']?(?:main\.)?["']?music_url["']?\s+WHERE\s+["']?id["']?\s*=\s*\?/i)
    assert.doesNotMatch(active, /music_info_other_source[\s\S]{0,160}WHERE\s+["']?source_id["']?\s*=\s*\?/i)
  })
})
