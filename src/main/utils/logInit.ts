import log from 'electron-log/node'

export const initLog = () => {
  log.transports.file.level = 'info'
  // log.initialize()
}
