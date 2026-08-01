// import { getListFromState } from './list'
// import { downloadList } from './download'


// export const getList = (listId: string | null): LX.Download.ListItem[] | LX.Music.MusicInfo[] => {
//   return listId == 'download' ? downloadList : getListFromState(listId)
// }
import { encodePath, isUrl } from '@common/utils/common'
import { joinPath } from '@common/utils/nodejs'
import { markRaw, shallowReactive } from '@common/utils/vueTools'
import { getThemes as getTheme } from '@renderer/utils/ipc'
import { themeInfo, themeShouldUseDarkColors, userApi } from './index'
import { appSetting } from './setting'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { supportQuality } from '@renderer/utils/musicSdk/api-source'
import {
  canOpenPrimaryDownloadWithRegistry,
  canStartPlaybackWithRegistry,
} from '@renderer/core/music/playback/sourceSelectors'

export const assertApiSupport = (source: LX.Source): boolean => {
  return canStartPlayback(source)
}

export const canStartPlayback = (source: LX.Source): boolean => {
  const installed = new Set(apiSourceInfo.filter(api => !api.disabled).map(api => api.id))
  if (userApi.listLoaded) for (const api of userApi.list) installed.add(api.id)
  return canStartPlaybackWithRegistry(source, appSetting, installed)
}

export const canOpenPrimaryDownload = (source: LX.Source): boolean => {
  return canOpenPrimaryDownloadWithRegistry(
    source,
    appSetting['common.apiSource'],
    supportQuality as Record<string, LX.QualityList>,
    new Set(userApi.list.map(api => api.id)),
    userApi.capabilities,
  )
}

export const buildBgUrl = (originUrl: string, dataPath: string): string => {
  return isUrl(originUrl)
    ? `url(${originUrl})`
    : `url(file:///${encodePath(joinPath(dataPath, originUrl).replaceAll('\\', '/'))})`
}

export const getThemes = (callback: (themeInfo: LX.ThemeInfo) => void) => {
  if (themeInfo.themes.length) {
    callback(themeInfo)
    return
  }
  void getTheme().then(info => {
    themeInfo.themes = markRaw(info.themes)
    themeInfo.userThemes = shallowReactive(info.userThemes)
    themeInfo.dataPath = info.dataPath
    callback(themeInfo)
  })
}
export const buildThemeColors = (theme: LX.Theme, dataPath: string) => {
  if (theme.isCustom && theme.config.extInfo['--background-image'] != 'none') {
    theme = copyTheme(theme)
    theme.config.extInfo['--background-image'] = buildBgUrl(theme.config.extInfo['--background-image'], dataPath)
  }
  const colors: Record<string, string> = {
    ...theme.config.themeColors,
    ...theme.config.extInfo,
  }

  return colors
}

export const copyTheme = (theme: LX.Theme): LX.Theme => {
  return {
    ...theme,
    config: {
      ...theme.config,
      extInfo: { ...theme.config.extInfo },
      themeColors: { ...theme.config.themeColors },
    },
  }
}

export const findTheme = (themeInfo: LX.ThemeInfo, id: string): LX.Theme | undefined => {
  let theme = themeInfo.themes.find(theme => theme.id == id)
  if (theme) return theme
  theme = themeInfo.userThemes.find(theme => theme.id == id)
  return theme
}

export const applyTheme = (id: string, lightId: string, darkId: string, dataPath: string) => {
  getThemes((themeInfo) => {
    let themeId = id == 'auto'
      ? themeShouldUseDarkColors.value
        ? darkId
        : lightId
      : id

    let theme = findTheme(themeInfo, themeId)
    if (!theme) {
      themeId = id == 'auto' && themeShouldUseDarkColors.value ? 'black' : 'green'
      theme = themeInfo.themes.find(theme => theme.id == themeId)!
    }
    window.setTheme(buildThemeColors(theme, dataPath))
  })
}
