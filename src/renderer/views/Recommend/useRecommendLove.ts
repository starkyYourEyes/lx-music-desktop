import { onBeforeUnmount, onMounted, ref } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { playMusicInfo } from '@renderer/store/player/state'
import { loveList } from '@renderer/store/list/state'
import { addListMusics, checkListExistMusic, removeListMusics } from '@renderer/store/list/action'

export const useRecommendLove = (homeSimilarSongs: { value: LX.Music.MusicInfoOnline[] }) => {
  const lovedHomeSongIds = ref(new Set<string>())

  let updateLoveToken = 0
  const updateHomeSongLoveStatuses = async() => {
    const songs = homeSimilarSongs.value
    const token = ++updateLoveToken
    if (!songs.length) {
      lovedHomeSongIds.value = new Set()
      return
    }

    const entries = await Promise.all(songs.map(async song => [
      song.id,
      await checkListExistMusic(loveList.id, song.id).catch(() => false),
    ] as const))
    if (token != updateLoveToken) return
    lovedHomeSongIds.value = new Set(entries.filter(([, isLoved]) => isLoved).map(([id]) => id))
  }

  const isHomeSongLoved = (song: LX.Music.MusicInfoOnline) => lovedHomeSongIds.value.has(song.id)

  const handleToggleHomeSongLove = async(song: LX.Music.MusicInfoOnline) => {
    const previousIds = new Set(lovedHomeSongIds.value)
    const nextIds = new Set(previousIds)
    const wasLoved = nextIds.has(song.id)
    if (wasLoved) nextIds.delete(song.id)
    else nextIds.add(song.id)
    lovedHomeSongIds.value = nextIds

    try {
      if (wasLoved) {
        if (playMusicInfo.listId == LIST_IDS.LOVE && playMusicInfo.musicInfo?.id == song.id) {
          playMusicInfo.isTempPlay = true
        }
        await removeListMusics({ listId: loveList.id, ids: [song.id] })
      } else {
        await addListMusics(loveList.id, [song])
      }
    } catch (err) {
      lovedHomeSongIds.value = previousIds
      console.warn('Toggle recommend song love failed:', err)
    }
  }

  const handleMyListUpdate = (ids: string[]) => {
    if (!ids.includes(loveList.id)) return
    void updateHomeSongLoveStatuses()
  }

  onMounted(() => {
    window.app_event.on('myListUpdate', handleMyListUpdate)
  })

  onBeforeUnmount(() => {
    window.app_event.off('myListUpdate', handleMyListUpdate)
  })

  return {
    lovedHomeSongIds,
    updateHomeSongLoveStatuses,
    isHomeSongLoved,
    handleToggleHomeSongLove,
  }
}
