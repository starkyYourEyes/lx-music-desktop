const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const errors = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/runtimeError.ts'))
const sourceErrors = loadTsModule(path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'))

test('maps the legacy too-many-requests text to rate limit before independent busy text', () => {
  assert.deepEqual(errors.normalizeRuntimeFailure({ statusCode: 429, message: 'x' }, { apiId: 'a' }), {
    name: 'PlaybackSourceError', message: 'x', scope: 'source', kind: 'rateLimit', apiId: 'a', statusCode: 429,
  })
  assert.equal(
    errors.normalizeRuntimeFailure(new Error('\u670d\u52a1\u5668\u7e41\u5fd9'), { apiId: 'a' }).kind,
    'rateLimit',
  )
  assert.equal(
    errors.normalizeRuntimeFailure(new Error('server busy'), { apiId: 'a' }).kind,
    'serverBusy',
  )
})

test('maps unknown failures to candidate request and bounds serialized text', () => {
  const failure = errors.normalizeRuntimeFailure(new Error('x'.repeat(2000)), { apiId: 'a' })
  assert.equal(failure.scope, 'candidate')
  assert.equal(failure.kind, 'request')
  assert.equal(failure.message.length, 1024)
})

test('local source errors retain cause while serialized failure data excludes it', () => {
  const cause = new Error('private upstream reason')
  const local = sourceErrors.createPlaybackSourceError({
    message: 'request failed', scope: 'candidate', kind: 'request', apiId: 'a', cause,
  })
  assert.equal(local.cause, cause)
  const serialized = errors.normalizeRuntimeFailure(local, { apiId: 'a' })
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, 'cause'), false)
})

test('cancellation wins over the underlying error', () => {
  assert.equal(errors.normalizeRuntimeFailure(new Error('boom'), {
    apiId: 'a', cancelled: true,
  }).kind, 'cancelled')
})
