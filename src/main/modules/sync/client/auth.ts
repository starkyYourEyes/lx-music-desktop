import { request, generateRsaKey } from './utils'
import { getSyncAuthKey, setSyncAuthKey } from './data'
import log from '../log'
import { aesDecrypt, aesEncrypt, getComputerName, rsaDecrypt } from '../utils'
import { toMD5 } from '@common/utils/nodejs'
import { SYNC_CODE } from '@common/constants_sync'
import { SYNC_PROTOCOLS, getSyncProtocolCandidates, type SyncProtocol } from '@common/syncProtocol'

class RetryableProtocolAuthError extends Error {}

const isClientKeyInfo = (value: unknown): value is LX.Sync.ClientKeyInfo => {
  if (value == null || typeof value != 'object') return false
  const info = value as Record<string, unknown>
  return typeof info.clientId == 'string' &&
    info.clientId.length > 0 &&
    typeof info.key == 'string' &&
    info.key.length > 0 &&
    typeof info.serverName == 'string' &&
    info.serverName.length > 0
}

const authenticateWithProtocols = async<T>(
  protocols: ReadonlyArray<Readonly<SyncProtocol>>,
  authenticate: (protocol: Readonly<SyncProtocol>) => Promise<T>,
) => {
  let lastError: unknown
  for (const [index, protocol] of protocols.entries()) {
    try {
      return { value: await authenticate(protocol), protocol }
    } catch (err) {
      lastError = err
      if (!(err instanceof RetryableProtocolAuthError) || index == protocols.length - 1) throw err
    }
  }
  throw lastError
}

const hello = async(urlInfo: LX.Sync.Client.UrlInfo) => request(`${urlInfo.httpProtocol}//${urlInfo.hostPath}/hello`)
  .then(({ text }) => text == SYNC_CODE.helloMsg)
  .catch((err: any) => {
    log.error('[auth] hello', err.message)
    console.log(err)
    return false
  })

const getServerId = async(urlInfo: LX.Sync.Client.UrlInfo) => request(`${urlInfo.httpProtocol}//${urlInfo.hostPath}/id`)
  .then(({ text }) => {
    if (!text.startsWith(SYNC_CODE.idPrefix)) return ''
    return text.replace(SYNC_CODE.idPrefix, '')
  })
  .catch((err: any) => {
    log.error('[auth] getServerId', err.message)
    console.log(err)
    throw err
  })

const codeAuth = async(urlInfo: LX.Sync.Client.UrlInfo, authCode: string, protocol: Readonly<SyncProtocol>) => {
  let key = toMD5(authCode).substring(0, 16)
  // const iv = Buffer.from(key.split('').reverse().join('')).toString('base64')
  key = Buffer.from(key).toString('base64')
  let { publicKey, privateKey } = await generateRsaKey()
  publicKey = publicKey.replace(/\n/g, '')
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
  const msg = aesEncrypt(`${protocol.syncAuthPrefix}\n${publicKey}\n${getComputerName()}\n${protocol.syncDesktopId}`, key)
  // console.log(msg, key)
  return request(`${urlInfo.httpProtocol}//${urlInfo.hostPath}/ah`, { headers: { m: msg } }).then(async({ text, code }) => {
    // console.log(text)
    switch (text) {
      case SYNC_CODE.msgBlockedIp:
        throw new Error(SYNC_CODE.msgBlockedIp)
      case SYNC_CODE.authFailed:
        throw new RetryableProtocolAuthError(SYNC_CODE.authFailed)
      default:
        if (code == 401) throw new RetryableProtocolAuthError(SYNC_CODE.authFailed)
        if (code != 200) throw new Error(SYNC_CODE.authFailed)
    }
    let msg
    try {
      msg = rsaDecrypt(Buffer.from(text, 'base64'), privateKey).toString()
    } catch (err: any) {
      log.error('[auth] codeAuth decryptMsg error', err.message)
      throw new Error(SYNC_CODE.authFailed)
    }
    // console.log(msg)
    if (!msg) return Promise.reject(new Error(SYNC_CODE.authFailed))
    let info: unknown
    try {
      info = JSON.parse(msg)
    } catch {
      throw new Error(SYNC_CODE.authFailed)
    }
    if (!isClientKeyInfo(info)) throw new Error(SYNC_CODE.authFailed)
    return info
  })
}

const keyAuth = async(urlInfo: LX.Sync.Client.UrlInfo, keyInfo: LX.Sync.ClientKeyInfo, protocol: Readonly<SyncProtocol>) => {
  const msg = aesEncrypt(protocol.syncAuthPrefix + getComputerName(), keyInfo.key)
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  return request(`${urlInfo.httpProtocol}//${urlInfo.hostPath}/ah`, { headers: { i: keyInfo.clientId, m: msg } }).then(({ text, code }) => {
    if (text == SYNC_CODE.msgBlockedIp) throw new Error(SYNC_CODE.msgBlockedIp)
    if (text == SYNC_CODE.authFailed || code == 401) throw new RetryableProtocolAuthError(SYNC_CODE.authFailed)
    if (code != 200) throw new Error(SYNC_CODE.authFailed)

    let msg
    try {
      msg = aesDecrypt(text, keyInfo.key)
    } catch (err: any) {
      log.error('[auth] keyAuth decryptMsg error', err.message)
      throw new Error(SYNC_CODE.authFailed)
    }
    if (msg != SYNC_CODE.helloMsg) return Promise.reject(new Error(SYNC_CODE.authFailed))
  })
}

const auth = async(urlInfo: LX.Sync.Client.UrlInfo, serverId: string, authCode?: string) => {
  if (authCode) {
    const { value, protocol } = await authenticateWithProtocols(SYNC_PROTOCOLS, async protocol => codeAuth(urlInfo, authCode, protocol))
    const keyInfo = {
      ...value,
      syncProtocol: protocol.id,
    }
    await setSyncAuthKey(serverId, keyInfo)
    return keyInfo
  }
  const keyInfo = await getSyncAuthKey(serverId)
  if (!keyInfo) throw new Error(SYNC_CODE.missingAuthCode)
  const { protocol } = await authenticateWithProtocols(
    getSyncProtocolCandidates(keyInfo.syncProtocol),
    async protocol => keyAuth(urlInfo, keyInfo, protocol),
  )
  const authKeyInfo = {
    ...keyInfo,
    syncProtocol: protocol.id,
  }
  await setSyncAuthKey(serverId, authKeyInfo)
  return authKeyInfo
}

export default async(urlInfo: LX.Sync.Client.UrlInfo, authCode?: string) => {
  console.log('connect: ', urlInfo.href, authCode)
  if (!await hello(urlInfo)) throw new Error(SYNC_CODE.connectServiceFailed)
  const serverId = await getServerId(urlInfo)
  if (!serverId) throw new Error(SYNC_CODE.getServiceIdFailed)
  return auth(urlInfo, serverId, authCode)
}
