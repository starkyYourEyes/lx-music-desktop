export interface SessionProxyConfig {
  host: string
  port: number
}

export const configureSessionProxy = async(
  targetSession: Electron.Session,
  proxy: SessionProxyConfig | null,
): Promise<void> => {
  if (proxy?.host) {
    await targetSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://${proxy.host}:${proxy.port}`,
    })
    return
  }

  await targetSession.setProxy({
    mode: 'direct',
  })
}
