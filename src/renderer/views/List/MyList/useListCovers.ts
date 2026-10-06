import { ref } from '@common/utils/vueTools'
import { getListMusics } from '@renderer/store/list/action'

export const useListCovers = (deps: { getListMusics: (id: string) => Promise<LX.Music.MusicInfo[]> } = { getListMusics }) => {
  const urls = new Map<string, string>()
  const pending = new Map<string, object>()
  const version = ref(0)

  const refresh = async(ids: string[]) => {
    await Promise.all(ids.map(async id => {
      const token = {}
      pending.set(id, token)
      let url = ''
      try {
        const list = await deps.getListMusics(id)
        url = list[0]?.meta?.picUrl ?? ''
      } catch {}
      // A newer read or removal owns the result now.
      if (pending.get(id) != token) return
      pending.delete(id)
      urls.set(id, url)
      version.value++
    }))
  }

  return {
    preload: refresh,
    refresh,
    remove: (ids: string[]) => {
      for (const id of ids) {
        pending.delete(id)
        if (urls.delete(id)) version.value++
      }
    },
    get: (id: string) => urls.get(id) ?? '',
    version,
  }
}
