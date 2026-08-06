<template lang="pug">
dd
  h3#local_music_webdav_connection WebDAV 音乐
  div
    .p
      | 地址
      input.input.gap-left(type="text" :value="appSetting['webdav.url']" :placeholder="PROJECT_IDENTITY.defaultWebdavUrl" @change="handleWebDAVUrlChange")
    .p
      | 用户名
      input.input.gap-left(v-model="webDAVUsername" type="text" placeholder="name@example.com")
    .p
      | 密码
      input.input.gap-left(v-model="webDAVPassword" type="password" placeholder="WebDAV 应用密码")
    .p
      base-btn.btn(min :disabled="isTestingWebDAV" @click="handleTestWebDAV") 测试连接
      base-btn.btn(min :disabled="isUpdatingWebDAVCredentials" @click="handleSaveWebDAVCredentials") 保存
      base-btn.btn(min :disabled="isUpdatingWebDAVCredentials || !webDAVCredentialStatus.configured" @click="handleRemoveWebDAVCredentials") 清除
    .p(v-if="webDAVCredentialStatus.configured")
      | 已保存：{{ webDAVCredentialStatus.usernameHint }}
    .p
      base-checkbox(id="setting_webdav_auto_refresh" :model-value="appSetting['webdav.autoRefresh']" label="启动时自动更新我的云盘" @update:model-value="updateSetting({'webdav.autoRefresh': $event})")
</template>

<script>
import { ref } from '@common/utils/vueTools'
import {
  testWebDAV,
  getWebDAVCredentialStatus,
  setWebDAVCredentials,
  removeWebDAVCredentials,
} from '@renderer/utils/ipc'
import { dialog } from '@renderer/plugins/Dialog'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { PROJECT_IDENTITY } from '@common/projectIdentity'

export default {
  name: 'SettingWebDAV',
  setup() {
    const isTestingWebDAV = ref(false)
    const isUpdatingWebDAVCredentials = ref(false)
    const webDAVUsername = ref('')
    const webDAVPassword = ref('')
    const webDAVCredentialStatus = ref({
      configured: false,
      usernameHint: null,
      persistence: 'missing',
    })
    const refreshWebDAVCredentialStatus = async() => {
      webDAVCredentialStatus.value = await getWebDAVCredentialStatus()
    }
    const handleWebDAVUrlChange = (event) => {
      updateSetting({ 'webdav.url': event.target.value.trim() })
    }
    const handleTestWebDAV = async() => {
      isTestingWebDAV.value = true
      try {
        await testWebDAV({
          url: appSetting['webdav.url'],
          username: webDAVUsername.value.trim(),
          password: webDAVPassword.value,
        })
        void dialog('WebDAV 连接成功')
      } catch (err) {
        void dialog(`WebDAV 连接失败：${err.message}`)
      } finally {
        isTestingWebDAV.value = false
      }
    }
    const handleSaveWebDAVCredentials = async() => {
      isUpdatingWebDAVCredentials.value = true
      try {
        await setWebDAVCredentials({
          username: webDAVUsername.value.trim(),
          password: webDAVPassword.value,
        })
        webDAVUsername.value = ''
        webDAVPassword.value = ''
        await refreshWebDAVCredentialStatus()
        void dialog('WebDAV 凭据已保存')
      } catch (err) {
        void dialog(`WebDAV 凭据保存失败：${err.message}`)
      } finally {
        isUpdatingWebDAVCredentials.value = false
      }
    }
    const handleRemoveWebDAVCredentials = async() => {
      isUpdatingWebDAVCredentials.value = true
      try {
        await removeWebDAVCredentials()
        webDAVUsername.value = ''
        webDAVPassword.value = ''
        await refreshWebDAVCredentialStatus()
      } catch (err) {
        void dialog(`WebDAV 凭据清除失败：${err.message}`)
      } finally {
        isUpdatingWebDAVCredentials.value = false
      }
    }
    void refreshWebDAVCredentialStatus().catch(() => {})

    return {
      PROJECT_IDENTITY,
      appSetting,
      updateSetting,
      isTestingWebDAV,
      isUpdatingWebDAVCredentials,
      webDAVUsername,
      webDAVPassword,
      webDAVCredentialStatus,
      handleWebDAVUrlChange,
      handleTestWebDAV,
      handleSaveWebDAVCredentials,
      handleRemoveWebDAVCredentials,
    }
  },
}
</script>
