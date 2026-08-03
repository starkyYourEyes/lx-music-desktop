import type { SessionRegistry } from './sessionRegistry'

export interface DefaultSessionLifetime {
  // eslint-disable-next-line @typescript-eslint/method-signature-style -- Preserve the shared Promise identity returned by admission.
  admit(session: Electron.Session): Promise<void>
}

export const createDefaultSessionLifetime = (
  registry: Pick<SessionRegistry, 'register'>,
): DefaultSessionLifetime => {
  let admittedSession: Electron.Session | null = null
  let ready: Promise<void> | null = null

  return {
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- Admission must return the exact shared registry barrier.
    admit(session) {
      if (ready != null) {
        if (admittedSession !== session) return Promise.reject(new Error('default_session_changed'))
        return ready
      }
      admittedSession = session
      const registration = registry.register({ key: 'electron:default', session })
      ready = registration.ready
      return ready
    },
  }
}
