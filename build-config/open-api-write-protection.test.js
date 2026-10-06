const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const load = require('../scripts/test-utils/load-ts-module')

const routes = [
  ['/play', ['play']], ['/pause', ['pause']], ['/skip-next', ['next']], ['/skip-prev', ['prev']],
  ['/seek?offset=12.3456', ['seek', 12.346]], ['/collect', ['collect']], ['/uncollect', ['unCollect']],
  ['/volume?volume=35', ['volume', 0.35]], ['/mute?mute=true', ['mute', true]],
]

const harness = async() => {
  let handler
  const effects = []
  const previous = global.lx
  global.lx = { player_status: { duration: 100, lyric: 'lyrics', status: 'playing' }, event_app: new EventEmitter() }
  const server = new EventEmitter()
  server.listen = () => server.emit('listening')
  server.address = () => ({ port: 12345 })
  server.close = cb => cb()
  const api = load('src/main/modules/openApi/index.ts', {
    'node:http': { createServer: cb => { handler = cb; return server } },
    '@common/utils/nodejs': { getAddress: () => ['192.168.1.25'] },
    '@main/modules/winMain': { sendTaskbarButtonClick: (...args) => effects.push(args) },
  })
  await api.startServer(12345, true)
  return {
    effects,
    request(url, headers = { host: 'localhost:12345' }) {
      const req = new EventEmitter()
      req.url = url
      req.headers = headers
      req.socket = { setTimeout() {} }
      const res = { headers: {}, writeHead(code, headers) { this.code = code; Object.assign(this.headers, headers) }, write() {}, end(body) { this.body = body } }
      handler(req, res)
      req.emit('close')
      return res
    },
    async dispose() { await api.stopServer(); global.lx = previous },
  }
}

test('all write routes and existing path aliases reject cross-site requests without effects or CORS', async() => {
  const h = await harness()
  try {
    for (const [route] of routes) {
      for (const prefix of ['', '/api']) {
        const res = h.request(prefix + route, { host: 'localhost:12345', 'sec-fetch-site': 'cross-site' })
        assert.equal(res.code, 403, route)
        assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
      }
    }
    assert.deepEqual(h.effects, [])
  } finally { await h.dispose() }
})

test('native clients and permitted fetch sites execute every write with local Host and no CORS', async() => {
  const h = await harness()
  try {
    for (const host of ['127.0.0.1:12345', 'localhost:12345', '192.168.1.25:12345']) {
      for (const site of [undefined, 'same-origin', 'none']) {
        for (const [route, effect] of routes) {
          const headers = { host }
          if (site !== undefined) headers['sec-fetch-site'] = site
          const res = h.request(route, headers)
          assert.equal(res.code, 200)
          assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
          assert.deepEqual(h.effects.pop(), effect)
        }
      }
    }
  } finally { await h.dispose() }
})

test('untrusted fetch sites and invalid, missing or malformed Hosts are denied before writes', async() => {
  const h = await harness()
  try {
    for (const site of ['same-site', '', 'SAME-ORIGIN', 'unknown', ['none', 'cross-site']]) {
      assert.equal(h.request('/pause', { host: 'localhost:12345', 'sec-fetch-site': site }).code, 403)
    }
    for (const host of [undefined, '', 'evil.example:12345', '192.168.1.26:12345', 'localhost', 'localhost:', 'localhost:0', 'localhost:65536', 'localhost:abc', 'localhost:12345/path', 'user@localhost:12345', 'localhost.evil:12345', '127.1:12345', ['localhost:12345']]) {
      const res = h.request('/pause', { host })
      assert.equal(res.code, 403, String(host))
      assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
    }
    assert.deepEqual(h.effects, [])
  } finally { await h.dispose() }
})

test('invalid write parameters have no effects or CORS while reads and SSE retain CORS', async() => {
  const h = await harness()
  try {
    for (const route of ['/seek', '/seek?offset=-1', '/seek?offset=101', '/volume', '/volume?volume=101', '/mute', '/mute?mute=invalid']) {
      const res = h.request(route)
      assert.equal(res.code, 400)
      assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
    }
    assert.deepEqual(h.effects, [])
    for (const route of ['/status', '/lyric', '/lyric-all', '/subscribe-player-status']) {
      const res = h.request(route, { host: 'evil.example:12345', 'sec-fetch-site': 'cross-site' })
      assert.equal(res.code, 200)
      assert.equal(res.headers['Access-Control-Allow-Origin'], '*')
    }
  } finally { await h.dispose() }
})
