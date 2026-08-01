<template lang="pug">
material-modal(:show="modelValue" :bg-close="!githubAction" :close-btn="!githubAction" teleport="#view" @close="handleClose")
  main.scroll(:class="$style.main")
    h2 {{ $t('user_api__title') }}
    div.scroll(v-if="apiList.length" :class="$style.content")
      section(v-for="group in apiGroups" :key="group.key" :class="$style.group")
        button(type="button" :class="$style.groupHeader" :aria-expanded="!collapsedGroups.has(group.key)" @click="toggleGroup(group.key)")
          span(:class="$style.groupName") {{ group.name || $t('user_api__github_local_group') }}
          span(:class="$style.groupCount") {{ group.apis.length }}
          svg(:class="[$style.groupIcon, { [$style.collapsed]: collapsedGroups.has(group.key) }]" version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024")
            use(xlink:href="#icon-down")
        ul(v-show="!collapsedGroups.has(group.key)")
          li(v-for="api in group.apis" :key="api.id" :class="[$style.listItem, {[$style.active]: appSetting['common.apiSource'] == api.id}]")
            div(:class="$style.listLeft")
              h3
                | {{ api.name }}
                span(v-if="api.version") {{ /^\d/.test(api.version) ? `v${api.version}` : api.version }}
                span(v-if="api.author") {{ api.author }}
              p {{ api.description }}
              div
                base-checkbox(:id="`user_api_${api.id}`" v-model="api.allowShowUpdateAlert" :class="$style.checkbox" :disabled="!!githubAction" :label="$t('user_api__allow_show_update_alert')" @change="handleChangeAllowUpdateAlert(api, $event)")
            base-btn(:class="$style.listBtn" outline :disabled="!!githubAction" :aria-label="$t('user_api__btn_remove')" @click.stop="handleRemove(api)")
              svg(v-once version="1.1" xmlns="http://www.w3.org/2000/svg" xlink="http://www.w3.org/1999/xlink" viewBox="0 0 212.982 212.982" space="preserve")
                use(xlink:href="#icon-delete")
    div(v-else :class="$style.content")
      div(:class="$style.noitem") {{ $t('user_api__noitem') }}
    div(:class="$style.note")
      p(:class="[$style.ruleLink]")
        | {{ $t('user_api__readme') }}
        span.hover.underline(:aria-label="projectIdentity.repositoryUrl + '#readme'" @click="handleOpenUrl(projectIdentity.repositoryUrl + '#readme')") 项目说明
      p {{ $t('user_api__note') }}
    div(v-if="githubStatus" :class="$style.githubStatus" role="status" aria-live="polite") {{ githubStatus }}
    div(:class="$style.footer")
      base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="handleGitHubTest") {{ $t(githubAction == 'test' ? 'user_api__github_testing' : 'user_api__github_test') }}
      base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="handleGitHubImport") {{ $t(githubAction == 'import' ? 'user_api__github_importing' : 'user_api__github_import') }}
      base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="isShowOnlineImportModal = true") {{ $t('user_api__btn_import_online') }}
      base-btn(:class="$style.footerBtn" :disabled="!!githubAction" @click="handleImport") {{ $t('user_api__btn_import') }}
      //- base-btn(:class="$style.footerBtn" @click="handleExport") {{ $t('user_api__btn_export') }}
    UserApiOnlineImportModal(v-model:show="isShowOnlineImportModal" @import="importUserApi")
</template>

<script>
import { importUserApi, removeUserApi, replaceUserApisFromGitHub, showSelectDialog, setAllowShowUserApiUpdateAlert } from '@renderer/utils/ipc'
import { getGitHubUserApiSnapshot, downloadGitHubUserApiSnapshot } from '@renderer/utils/githubUserApi'
import { readFile } from '@common/utils/nodejs'
import { openUrl } from '@common/utils/electron'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { computed, ref } from '@common/utils/vueTools'
import { dialog } from '@renderer/plugins/Dialog'
import { PROJECT_IDENTITY } from '@common/projectIdentity'

import UserApiOnlineImportModal from './UserApiOnlineImportModal.vue'

export default {
  components: {
    UserApiOnlineImportModal,
  },
  props: {
    modelValue: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['update:modelValue'],
  setup() {
    const isShowOnlineImportModal = ref(false)
    const apiList = computed(() => userApi.list)

    return {
      userApi,
      apiList,
      appSetting,
      isShowOnlineImportModal,
      projectIdentity: PROJECT_IDENTITY,
    }
  },
  data() {
    return {
      githubAction: '',
      githubStatus: '',
      githubViewGeneration: 0,
      collapsedGroups: new Set(),
    }
  },
  computed: {
    apiGroups() {
      const groups = new Map()
      for (const api of this.apiList) {
        const name = api.remote?.group ?? ''
        const key = name ? 'remote:' + name : 'local:'
        if (!groups.has(key)) groups.set(key, { key, name, apis: [] })
        groups.get(key).apis.push(api)
      }
      return [...groups.values()]
    },
  },
  watch: {
    modelValue(show) {
      this.githubViewGeneration++
      if (!show) return
      this.collapsedGroups = new Set()
      this.githubStatus = ''
    },
  },
  beforeUnmount() {
    this.githubViewGeneration++
  },
  methods: {
    async importUserApi(script) {
      return importUserApi(script).then(({ apiList }) => {
        userApi.list = apiList
      }).catch((err) => {
        void dialog(this.$t('user_api_import__failed', { message: err.message }))
      })
    },
    toggleGroup(name) {
      if (this.collapsedGroups.has(name)) this.collapsedGroups.delete(name)
      else this.collapsedGroups.add(name)
    },
    formatGitHubError(err) {
      const errorKeys = {
        GITHUB_RATE_LIMIT: 'user_api__github_error_rate_limit',
        GITHUB_HTTP_ERROR: 'user_api__github_error_http',
        GITHUB_INVALID_RESPONSE: 'user_api__github_error_tree',
        GITHUB_TREE_TRUNCATED: 'user_api__github_error_tree',
        GITHUB_VERSION_NOT_FOUND: 'user_api__github_error_version',
        GITHUB_SCRIPTS_NOT_FOUND: 'user_api__github_error_scripts',
        GITHUB_BATCH_LIMIT: 'user_api__github_error_limit',
        GITHUB_INVALID_SCRIPT: 'user_api__github_error_invalid_script',
      }
      const detail = String(err?.detail || err?.message || err || '')
        .split(/\r?\n/, 1)[0]
        .substring(0, 500)
      return this.$t(errorKeys[err?.code] ?? 'user_api__github_error_generic', {
        message: detail,
      })
    },
    reconcileApiList(apiList, previousCustomIds) {
      userApi.list = apiList
      const selectedId = appSetting['common.apiSource']
      if (!previousCustomIds.has(selectedId) || apiList.some(api => api.id == selectedId)) return
      const fallback = apiSourceInfo.find(api => !api.disabled) ?? apiList[0]
      setApiSource(fallback?.id ?? '')
    },
    isGitHubViewCurrent(viewGeneration) {
      return this.modelValue && this.githubViewGeneration == viewGeneration
    },
    async handleGitHubTest() {
      if (this.githubAction) return
      const action = 'test'
      this.githubAction = action
      const viewGeneration = this.githubViewGeneration
      this.githubStatus = this.$t('user_api__github_testing')
      try {
        const snapshot = await getGitHubUserApiSnapshot()
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        this.githubStatus = this.$t('user_api__github_test_success', {
          version: snapshot.version,
          count: snapshot.files.length,
          commit: snapshot.commitSha.substring(0, 7),
        })
      } catch (err) {
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        const message = this.formatGitHubError(err)
        this.githubStatus = message
        void dialog(message)
      } finally {
        if (this.githubAction == action) this.githubAction = ''
      }
    },
    async handleGitHubImport() {
      if (this.githubAction) return
      const action = 'import'
      this.githubAction = action
      const viewGeneration = this.githubViewGeneration
      const oldCustomIds = new Set(this.apiList.map(api => api.id))
      this.githubStatus = this.$t('user_api__github_importing')
      try {
        const snapshot = await getGitHubUserApiSnapshot()
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        const confirmed = await this.$dialog.confirm({
          message: this.$t('user_api__github_import_confirm', {
            localCount: this.apiList.length,
            version: snapshot.version,
            remoteCount: snapshot.files.length,
          }),
          confirmButtonText: this.$t('confirm_button_text'),
          cancelButtonText: this.$t('cancel_button_text'),
        })
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        if (!confirmed) {
          this.githubStatus = ''
          return
        }

        const items = await downloadGitHubUserApiSnapshot(snapshot)
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        const apiList = await replaceUserApisFromGitHub(items)
        this.reconcileApiList(apiList, oldCustomIds)
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        this.githubStatus = this.$t('user_api__github_import_success', {
          version: snapshot.version,
          count: apiList.length,
        })
      } catch (err) {
        if (err instanceof Error && 'apiList' in err && Array.isArray(err.apiList)) {
          this.reconcileApiList(err.apiList, oldCustomIds)
        }
        if (!this.isGitHubViewCurrent(viewGeneration)) return
        const message = this.formatGitHubError(err)
        this.githubStatus = message
        void dialog(message)
      } finally {
        if (this.githubAction == action) this.githubAction = ''
      }
    },
    handleImport() {
      void showSelectDialog({
        title: this.$t('user_api__import_file'),
        properties: ['openFile'],
        filters: [
          { name: 'LX API File', extensions: ['js'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }).then(async result => {
        if (result.canceled) return
        return readFile(result.filePaths[0]).then(async data => {
          return this.importUserApi(data.toString())
        })
      })
    },
    handleExport() {

    },
    async handleRemove(api) {
      if (this.githubAction) return
      if (appSetting['common.apiSource'] == api.id) {
        let backApi = apiSourceInfo.find(api => !api.disabled)
        if (!backApi) backApi = userApi.list.find(item => item.id != api.id)
        setApiSource(backApi?.id ?? '')
      }
      await removeUserApi([api.id], apiList => {
        userApi.list = apiList
      })
    },
    handleClose() {
      if (this.githubAction) return
      this.$emit('update:modelValue', false)
    },
    handleOpenUrl(url) {
      void openUrl(url)
    },
    handleChangeAllowUpdateAlert(api, enable) {
      if (this.githubAction) return
      void setAllowShowUserApiUpdateAlert(api.id, enable)
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  padding: 15px 8px;
  max-width: 550px;
  min-width: 300px;
  display: flex;
  flex-flow: column nowrap;
  min-height: 0;
  // max-height: 100%;
  // overflow: hidden;
  h2 {
    font-size: 16px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
  }
}

.name {
  color: var(--color-primary);
}

.checkbox {
  margin-top: 3px;
  font-size: 14px;
  opacity: .86;
}

.content {
  flex: auto;
  min-height: 80px;
  max-height: 100%;
  margin-top: 15px;
  padding: 0 7px;
}
.group {
  + .group {
    margin-top: 8px;
  }
}
.groupHeader {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 7px 10px;
  border: 0;
  border-radius: @radius-border;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 16px;
  gap: 8px;
  align-items: center;
  color: var(--color-font);
  background-color: transparent;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s ease;
  &:hover,
  &:focus-visible {
    background-color: var(--color-primary-background-hover);
    outline: none;
  }
}
.groupName {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.groupCount {
  color: var(--color-font-label);
  font-size: 12px;
}
.groupIcon {
  width: 16px;
  height: 16px;
  color: var(--color-font-label);
  fill: currentColor;
  transition: transform 0.2s ease;
  &.collapsed {
    transform: rotate(-90deg);
  }
}
.listItem {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  transition: background-color 0.2s ease;
  padding: 15px 10px;
  border-radius: @radius-border;
  &:hover {
    background-color: var(--color-primary-background-hover);
  }
  &.active {
    background-color: var(--color-primary-background-active);
  }
  h3 {
    font-size: 15px;
    color: var(--color-font);
    word-break: break-all;
    span {
      font-size: 12px;
      color: var(--color-font-label);
      margin-left: 6px;
    }
  }
  p {
    margin-top: 5px;
    font-size: 14px;
    color: var(--color-font-label);
    word-break: break-all;
  }
}
.noitem {
  height: 100px;
  font-size: 18px;
  color: var(--color-font-label);
  display: flex;
  justify-content: center;
  align-items: center;
}
.listLeft {
  flex: auto;
  min-width: 0;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
}
.listBtn {
  flex: none;
  height: 30px;
  width: 30px;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  svg {
    width: 60%;
  }
}
.note {
  padding: 0 7px;
  margin-top: 15px;
  font-size: 12px;
  line-height: 1.25;
  color: var(--color-font);
  p {
    + p {
      margin-top: 5px;
    }
  }
}
.githubStatus {
  min-width: 0;
  padding: 0 7px;
  margin-top: 10px;
  color: var(--color-font-label);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.footer {
  padding: 0 7px;
  margin-top: 15px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.footerBtn {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  line-height: 1.2;
  padding: 0 10px !important;
  white-space: normal;
  overflow-wrap: anywhere;
}
.ruleLink {
  .mixin-ellipsis-1();
}

@media (max-width: 420px) {
  .footer {
    grid-template-columns: minmax(0, 1fr);
  }
}


</style>
