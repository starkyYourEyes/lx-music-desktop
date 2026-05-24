<template>
  <material-modal :show="party.isShowModal" @close="handleClose">
    <main :class="$style.main">
      <section :class="$style.hero">
        <div>
          <p :class="$style.eyebrow">PARTY SYNC</p>
          <h2 :class="$style.title">一起听</h2>
          <p :class="$style.desc">房间默认全员可控，所有成员都可以切歌、暂停、拖动进度，也可以一起维护共享稍后播放队列。</p>
        </div>
        <div v-if="party.room" :class="$style.heroBadge">
          <span>{{ party.room.members.filter(member => member.isOnline).length }}/{{ party.room.members.length }}</span>
          <small>在线</small>
        </div>
      </section>

      <section v-if="party.room" :class="$style.roomCard">
        <div :class="$style.roomHeader">
          <div>
            <p :class="$style.roomLabel">当前房间</p>
            <h3 :class="$style.roomName">{{ party.room.name || '一起听房间' }}</h3>
          </div>
          <div :class="$style.roomCodeBox">
            <span :class="$style.roomCode">{{ party.room.roomCode }}</span>
            <base-btn min @click="handleCopyRoomCode">复制房间号</base-btn>
          </div>
        </div>

        <div :class="$style.metaRow">
          <span :class="$style.metaChip">{{ party.room.settings.controlMode === 'all' ? '全员可控' : '仅房主可控' }}</span>
          <span :class="$style.metaChip">{{ currentMusicText }}</span>
        </div>

        <section :class="$style.sectionCard">
          <div :class="$style.sectionHeader">
            <div>
              <p :class="$style.sectionLabel">共享稍后播放</p>
              <p :class="$style.sectionDesc">队列中的歌曲会优先作为房间下一首播放；队列为空时，继续按原来的本地播放逻辑执行。</p>
            </div>
            <base-btn min :disabled="isSubmitting || !currentPlayableMusic" @click="handleAddCurrentSong">
              {{ isSubmittingAction === 'addSong' ? '添加中...' : '加入当前歌曲' }}
            </base-btn>
          </div>

          <p v-if="!queue.length" :class="$style.queueEmpty">当前还没有共享队列歌曲</p>

          <div v-else :class="$style.queueList">
            <div
              v-for="(item, index) in queue"
              :key="item.id"
              :class="[$style.queueItem, {[$style.queueItemActive]: isCurrentQueueItem(item, index)}]"
            >
              <div :class="$style.queueItemTop">
                <div>
                  <p :class="$style.queueOrder">队列 {{ index + 1 }}</p>
                  <p :class="$style.queueTitle">{{ item.musicInfo.name }}</p>
                  <p :class="$style.queueMeta">{{ item.musicInfo.singer }}</p>
                  <p :class="$style.queueMeta">添加者：{{ getMemberName(item.requestedBy) }}</p>
                </div>
                <div :class="$style.queueActions">
                  <span v-if="isCurrentQueueItem(item, index)" :class="$style.nowPlayingTag">正在播放</span>
                  <base-btn
                    min
                    outline
                    :disabled="isSubmitting"
                    @click="handleRemoveQueueItem(item.id)"
                  >
                    {{ isSubmittingAction === `remove:${item.id}` ? '删除中...' : '删除' }}
                  </base-btn>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div :class="$style.members">
          <div
            v-for="member in party.room.members"
            :key="member.clientId"
            :class="[$style.member, {[$style.memberOffline]: !member.isOnline}]"
          >
            <div :class="$style.memberHead">
              <span :class="$style.memberName">{{ getMemberName(member) }}</span>
              <span v-if="member.clientId === party.selfClientId" :class="$style.meTag">我</span>
              <span v-if="member.isHost" :class="$style.hostTag">房主</span>
            </div>
            <div :class="$style.memberMeta">
              <span>{{ member.deviceName }}</span>
              <span>{{ member.isOnline ? '在线' : '离线' }}</span>
            </div>
          </div>
        </div>

        <p v-if="statusText" :class="$style.statusText">{{ statusText }}</p>

        <div :class="$style.actions">
          <base-btn outline @click="handleClose">关闭</base-btn>
          <base-btn :disabled="isSubmitting" @click="handleLeaveRoom">退出房间</base-btn>
        </div>
      </section>

      <template v-else>
        <div :class="$style.grid">
          <section :class="$style.panel">
            <div :class="$style.panelHead">
              <h3>创建房间</h3>
              <p>可以自定义房间名和房间号，不填则自动生成。</p>
            </div>
            <base-input v-model="createForm.name" :class="$style.input" placeholder="房间名称（可选）" />
            <base-input v-model="createForm.roomCode" :class="$style.input" placeholder="房间号（4-12 位大写字母或数字，可选）" />
            <base-input v-model="createForm.displayName" :class="$style.input" placeholder="你的昵称（可选）" />
            <div :class="$style.panelFooter">
              <base-btn :disabled="isSubmitting" @click="handleCreateRoom">创建并加入</base-btn>
            </div>
          </section>

          <section :class="$style.panel">
            <div :class="$style.panelHead">
              <h3>加入房间</h3>
              <p>输入房间号即可加入，支持带密码房间。</p>
            </div>
            <base-input v-model="joinForm.roomCode" :class="$style.input" placeholder="房间号" />
            <base-input v-model="joinForm.password" :class="$style.input" placeholder="房间密码（可选）" />
            <base-input v-model="joinForm.displayName" :class="$style.input" placeholder="你的昵称（可选）" />
            <div :class="$style.panelFooter">
              <base-btn :disabled="isSubmitting || !joinForm.roomCode" @click="handleJoinRoom">加入一起听</base-btn>
            </div>
          </section>
        </div>

        <p v-if="statusText" :class="$style.statusText">{{ statusText }}</p>
      </template>
    </main>
  </material-modal>
</template>

<script>
import { computed, reactive, ref } from '@common/utils/vueTools'
import {
  appendPartyQueue,
  copyPartyRoomCode,
  createPartyRoom,
  getPartyErrorMessage,
  getPartyQueue,
  joinPartyRoom,
  leavePartyRoom,
  removePartyQueueItems,
} from '@renderer/core/party'
import { playMusicInfo } from '@renderer/store/player/state'
import { party } from '@renderer/store/party'

const normalizeRoomCode = value => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)

export default {
  setup() {
    const isSubmitting = ref(false)
    const isSubmittingAction = ref('')
    const statusText = ref('')
    const createForm = reactive({
      name: '',
      roomCode: '',
      displayName: '',
    })
    const joinForm = reactive({
      roomCode: '',
      password: '',
      displayName: '',
    })

    const currentMusicText = computed(() => {
      const music = party.room?.playback.currentMusic
      if (!music) return '等待同步歌曲'
      return `${party.room?.playback.playing ? '播放中' : '已暂停'} · ${music.name} - ${music.singer}`
    })

    const currentPlayableMusic = computed(() => {
      const music = playMusicInfo.musicInfo
      if (!music) return null
      return 'progress' in music ? music.metadata.musicInfo : music
    })

    const queue = computed(() => getPartyQueue())
    const currentQueueIndex = computed(() => party.room?.playback.currentIndex ?? -1)

    const getMemberName = member => member.displayName || member.userName || member.deviceName

    const isCurrentQueueItem = (item, index) => {
      if (currentQueueIndex.value === index) return true
      const currentMusic = party.room?.playback.currentMusic
      if (currentQueueIndex.value >= 0 || !currentMusic) return false
      return currentMusic.id === item.musicInfo.id && currentMusic.source === item.musicInfo.source
    }

    const handleClose = () => {
      party.isShowModal = false
      statusText.value = ''
    }

    const runAction = async(action, type = '') => {
      isSubmitting.value = true
      isSubmittingAction.value = type
      statusText.value = ''
      try {
        await action()
      } catch (error) {
        statusText.value = getPartyErrorMessage(error)
      } finally {
        isSubmitting.value = false
        isSubmittingAction.value = ''
      }
    }

    const handleCreateRoom = async() => {
      createForm.roomCode = normalizeRoomCode(createForm.roomCode)
      await runAction(async() => {
        await createPartyRoom({
          name: createForm.name.trim() || undefined,
          roomCode: createForm.roomCode || undefined,
          displayName: createForm.displayName.trim() || undefined,
        })
        statusText.value = '房间已创建'
      }, 'create')
    }

    const handleJoinRoom = async() => {
      joinForm.roomCode = normalizeRoomCode(joinForm.roomCode)
      if (!joinForm.roomCode) {
        statusText.value = '请输入房间号'
        return
      }
      await runAction(async() => {
        await joinPartyRoom({
          roomCode: joinForm.roomCode,
          password: joinForm.password.trim() || undefined,
          displayName: joinForm.displayName.trim() || undefined,
        })
        statusText.value = '已加入房间'
      }, 'join')
    }

    const handleLeaveRoom = async() => {
      await runAction(async() => {
        await leavePartyRoom()
        statusText.value = '已退出房间'
      }, 'leave')
    }

    const handleCopyRoomCode = () => {
      copyPartyRoomCode()
      statusText.value = '房间号已复制'
    }

    const handleAddCurrentSong = async() => {
      if (!currentPlayableMusic.value) {
        statusText.value = '当前没有可加入队列的歌曲'
        return
      }
      await runAction(async() => {
        await appendPartyQueue([{ musicInfo: currentPlayableMusic.value }])
        statusText.value = '已加入共享队列'
      }, 'addSong')
    }

    const handleRemoveQueueItem = async(id) => {
      await runAction(async() => {
        await removePartyQueueItems([id])
        statusText.value = '已从共享队列移除'
      }, `remove:${id}`)
    }

    return {
      party,
      queue,
      createForm,
      joinForm,
      isSubmitting,
      isSubmittingAction,
      statusText,
      currentMusicText,
      currentPlayableMusic,
      currentQueueIndex,
      handleClose,
      handleCreateRoom,
      handleJoinRoom,
      handleLeaveRoom,
      handleCopyRoomCode,
      handleAddCurrentSong,
      handleRemoveQueueItem,
      getMemberName,
      isCurrentQueueItem,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 20px;
  width: min(900px, 82vw);
  max-height: min(84vh, 780px);
  overflow: auto;
  color: var(--color-font);
}

.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 22px;
  border-radius: 18px;
  background:
    radial-gradient(circle at top right, var(--color-primary-light-100-alpha-600), transparent 45%),
    linear-gradient(135deg, var(--color-primary-light-100-alpha-800), var(--color-main-background));
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.08);
}

.eyebrow {
  font-size: 12px;
  letter-spacing: 0.18em;
  opacity: 0.68;
}

.title {
  margin-top: 6px;
  font-size: 30px;
  line-height: 1.05;
}

.desc {
  margin-top: 10px;
  max-width: 560px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-font-label);
}

.heroBadge {
  flex: none;
  min-width: 92px;
  padding: 16px 14px;
  border-radius: 16px;
  text-align: center;
  background: rgba(255, 255, 255, 0.58);
  backdrop-filter: blur(8px);

  span {
    display: block;
    font-size: 26px;
    font-weight: bold;
  }

  small {
    display: block;
    margin-top: 4px;
    font-size: 12px;
    color: var(--color-font-label);
  }
}

.grid {
  margin-top: 18px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.panel,
.roomCard {
  margin-top: 18px;
  padding: 18px;
  border-radius: 18px;
  background-color: var(--color-content-background);
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.08);
}

.panelHead {
  margin-bottom: 14px;

  h3 {
    font-size: 18px;
  }

  p {
    margin-top: 6px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--color-font-label);
  }
}

.input {
  width: 100%;
  display: block;
  padding: 10px 12px;

  + .input {
    margin-top: 10px;
  }
}

.panelFooter,
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}

.roomHeader {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
}

.roomLabel {
  font-size: 12px;
  color: var(--color-font-label);
}

.roomName {
  margin-top: 4px;
  font-size: 24px;
}

.roomCodeBox {
  display: flex;
  align-items: center;
  gap: 10px;
}

.roomCode {
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 18px;
  font-weight: bold;
  letter-spacing: 0.1em;
  background: var(--color-primary-light-100-alpha-900);
}

.metaRow {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.metaChip {
  padding: 7px 12px;
  border-radius: 999px;
  background: var(--color-primary-light-100-alpha-700);
  font-size: 12px;
}

.sectionCard {
  margin-top: 18px;
  padding: 16px;
  border-radius: 16px;
  background: var(--color-main-background);
}

.sectionHeader {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.sectionLabel {
  font-size: 12px;
  color: var(--color-font-label);
}

.sectionDesc {
  margin-top: 6px;
  max-width: 520px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--color-font-label);
}

.queueEmpty {
  margin-top: 14px;
  font-size: 13px;
  color: var(--color-font-label);
}

.queueList {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}

.queueItem {
  padding: 14px;
  border-radius: 14px;
  background: var(--color-content-background);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.06);
}

.queueItemActive {
  border: 1px solid var(--color-primary-light-500-alpha-800);
  background: var(--color-primary-light-100-alpha-700);
}

.queueItemTop {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}

.queueActions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.queueOrder {
  font-size: 11px;
  color: var(--color-font-label);
}

.queueTitle {
  margin-top: 4px;
  font-size: 15px;
  font-weight: bold;
}

.queueMeta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-font-label);
}

.nowPlayingTag {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--color-primary);
  background: var(--color-primary-light-100-alpha-900);
}

.members {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.member {
  padding: 14px;
  border-radius: 14px;
  background: var(--color-main-background);
}

.memberOffline {
  opacity: 0.58;
}

.memberHead {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.memberName {
  font-weight: bold;
}

.meTag,
.hostTag {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--color-primary-light-100-alpha-900);
}

.memberMeta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-font-label);
}

.statusText {
  margin-top: 14px;
  font-size: 13px;
  color: var(--color-primary);
}

@media (max-width: 820px) {
  .main {
    width: min(92vw, 92vw);
    padding: 16px;
  }

  .grid,
  .members {
    grid-template-columns: 1fr;
  }

  .hero,
  .roomHeader,
  .roomCodeBox,
  .sectionHeader,
  .queueItemTop {
    flex-direction: column;
    align-items: flex-start;
  }

  .queueActions {
    align-items: flex-start;
  }
}
</style>
