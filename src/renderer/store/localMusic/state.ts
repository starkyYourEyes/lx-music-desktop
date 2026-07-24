import { ref, shallowReactive } from '@common/utils/vueTools'

export const LOCAL_MUSIC_LIST_ID = 'local_music'

export const localMusicList = shallowReactive<LX.Music.MusicInfoLocal[]>([])

export const isScanningLocalMusic = ref(false)

export const localMusicScanError = ref('')

export const uploadingLocalMusicIds = shallowReactive<Record<string, boolean>>({})
