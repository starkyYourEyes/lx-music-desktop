import type { WebContents } from 'electron'

type NavigationGuard = (url: string) => boolean

const navigationGuards = new WeakMap<WebContents, NavigationGuard>()

export const registerWebContentsNavigationGuard = (
  contents: WebContents,
  guard: NavigationGuard,
): (() => void) => {
  navigationGuards.set(contents, guard)
  return () => {
    if (navigationGuards.get(contents) == guard) navigationGuards.delete(contents)
  }
}

export const getWebContentsNavigationDecision = (
  contents: WebContents,
  url: string,
): boolean | undefined => {
  return navigationGuards.get(contents)?.(url)
}
