/* eslint-disable n/no-deprecated-api */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const typescript = require('typescript')

const root = path.resolve(__dirname, '..')
const previousLoader = require.extensions['.ts']
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText
  mod._compile(output, filename)
}

const { createNeteaseUserPlaylistService } = require(path.join(root, 'src/main/modules/netease/userPlaylists.ts'))
require.extensions['.ts'] = previousLoader

const createService = ({ responses, cookie = 'MUSIC_U=fixture', profile = { userId: 42, nickname: 'User', avatarUrl: '' } }) => {
  const calls = []
  const api = {
    user_playlist: async params => {
      calls.push(params)
      const response = responses.shift()
      if (response instanceof Error) throw response
      return response
    },
  }
  return {
    calls,
    service: createNeteaseUserPlaylistService({
      api,
      getCookie: () => cookie,
      getProfile: () => profile,
    }),
  }
}

test('normalizes created and collected playlists across pages without duplicate IDs', async() => {
  const { service, calls } = createService({
    responses: [
      {
        body: {
          code: 200,
          more: true,
          playlist: [
            { id: 1, name: 'Created', coverImgUrl: 'https://img.example/created.jpg', creator: { userId: 42 } },
            { id: '2', name: 'Collected', picUrl: 'https://img.example/collected.jpg', creator: { userId: 9 } },
          ],
        },
      },
      {
        body: {
          code: 200,
          more: false,
          playlist: [
            { id: 1, name: 'Duplicate', coverImgUrl: 'https://img.example/duplicate.jpg', creator: { userId: 42 } },
            { id: 3, name: undefined, creator: { userId: '42' } },
          ],
        },
      },
    ],
  })

  assert.deepEqual(await service.getUserPlaylists(), [
    {
      provider: 'netease',
      kind: 'created',
      id: '1',
      sourceListId: '1',
      name: 'Created',
      coverUrl: 'https://img.example/created.jpg',
      accountKey: '42',
    },
    {
      provider: 'netease',
      kind: 'collected',
      id: '2',
      sourceListId: '2',
      name: 'Collected',
      coverUrl: 'https://img.example/collected.jpg',
      accountKey: '42',
    },
    {
      provider: 'netease',
      kind: 'created',
      id: '3',
      sourceListId: '3',
      name: '',
      coverUrl: '',
      accountKey: '42',
    },
  ])
  assert.deepEqual(calls, [
    { cookie: 'MUSIC_U=fixture', uid: 42, limit: 1000, offset: 0 },
    { cookie: 'MUSIC_U=fixture', uid: 42, limit: 1000, offset: 2 },
  ])
})

test('propagates missing authentication, API failures, and transport failures', async() => {
  const missingCookie = createService({ responses: [], cookie: '' }).service
  await assert.rejects(missingCookie.getUserPlaylists(), /Not logged in/)

  const apiFailure = createService({ responses: [{ body: { code: 401, message: 'login required' } }] }).service
  await assert.rejects(apiFailure.getUserPlaylists(), /login required/)

  const transportFailure = createService({ responses: [new Error('network unavailable')] }).service
  await assert.rejects(transportFailure.getUserPlaylists(), /network unavailable/)
})

test('registers the typed NetEase user playlist IPC boundary', () => {
  const names = fs.readFileSync(path.join(root, 'src/common/ipcNames.ts'), 'utf8')
  const neteaseTypes = fs.readFileSync(path.join(root, 'src/common/types/netease.d.ts'), 'utf8')
  const handlers = fs.readFileSync(path.join(root, 'src/main/modules/winMain/rendererEvent/netease.ts'), 'utf8')
  const rendererIpc = fs.readFileSync(path.join(root, 'src/renderer/utils/ipc.ts'), 'utf8')

  assert.match(names, /netease_get_user_playlist_summaries: 'netease_get_user_playlist_summaries'/)
  assert.match(neteaseTypes, /interface UserPlaylistSummary extends LX\.PlatformPlaylistSummary/)
  assert.match(handlers, /netease_get_user_playlist_summaries/)
  assert.match(handlers, /getNeteaseUserPlaylists\(/)
  assert.match(rendererIpc, /export const getNeteaseUserPlaylists/)
  assert.match(rendererIpc, /rendererInvoke<readonly LX\.PlatformPlaylistKind\[\] \| undefined, LX\.PlatformPlaylistSummary\[\]>\(WIN_MAIN_RENDERER_EVENT_NAME\.netease_get_user_playlist_summaries, kinds\)/)
})

test('disabled kinds skip requests and malformed or stuck pages fail without an empty success', async() => {
  const disabled = createService({ responses: [], cookie: '' })
  assert.deepEqual(await disabled.service.getUserPlaylists([]), [])
  assert.equal(disabled.calls.length, 0)
  const malformed = createService({ responses: [{ body: { code: 200 } }] })
  await assert.rejects(malformed.service.getUserPlaylists(), /Invalid user playlist/)
  const page = { body: { code: 200, more: true, playlist: [{ id: 1, creator: { userId: 42 } }] } }
  const repeated = createService({ responses: [page, page] })
  await assert.rejects(repeated.service.getUserPlaylists(), /pagination did not advance/)
  const createdOnly = createService({ responses: [{ body: { code: 200, playlist: [
    { id: 1, creator: { userId: 42 } }, { id: 2, creator: { userId: 9 } },
  ] } }] })
  assert.deepEqual((await createdOnly.service.getUserPlaylists(['created'])).map(list => list.kind), ['created'])
})
