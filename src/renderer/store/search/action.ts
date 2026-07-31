
import {
  getSearchHistory,
  mutateSearchHistory,
} from '@renderer/utils/storageState'
import { appSetting } from '../setting'
import { searchText, historyList } from './state'


export const setSearchText = (text: string) => {
  searchText.value = text
}

let isInitedSearchHistory = false

const replaceHistoryList = (list: string[]) => {
  historyList.splice(0, historyList.length, ...list)
}

export const getHistoryList = async() => {
  if (isInitedSearchHistory || historyList.length) return
  replaceHistoryList(await getSearchHistory())
  isInitedSearchHistory ||= true
}
export const addHistoryWord = async(word: string) => {
  if (!appSetting['search.isShowHistorySearch']) return
  if (!isInitedSearchHistory) await getHistoryList()
  const index = historyList.indexOf(word)
  if (index == 0) return
  replaceHistoryList(await mutateSearchHistory({ version: 1, action: 'record', term: word, usedAtMs: Date.now() }))
}
export const removeHistoryWord = async(index: number) => {
  const term = historyList[index]
  if (term == null) return
  replaceHistoryList(await mutateSearchHistory({ version: 1, action: 'remove', term }))
}
export const clearHistoryList = async() => {
  replaceHistoryList(await mutateSearchHistory({ version: 1, action: 'clear' }))
}
