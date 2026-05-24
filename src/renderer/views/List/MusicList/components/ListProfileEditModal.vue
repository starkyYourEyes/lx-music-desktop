<template>
  <material-modal :show="visible" max-width="920px" width="82vw" teleport="#view" @close="handleCancel">
    <main :class="$style.main">
      <h2 :class="$style.title">{{ $t('list_profile__edit_title') }}</h2>
      <div :class="$style.content">
        <div :class="$style.form">
          <label :class="$style.field">
            <span :class="$style.label">{{ $t('list_profile__name') }}</span>
            <div :class="$style.inputWrap">
              <base-input v-model="name" :class="$style.input" :placeholder="$t('list__new_list_input')" @update:model-value="handleNameInput" />
              <span :class="$style.counter">{{ name.length }}/40</span>
            </div>
          </label>
          <label :class="[$style.field, $style.descField]">
            <span :class="$style.label">{{ $t('list_profile__description') }}</span>
            <div :class="$style.textareaWrap">
              <textarea
                v-model="description"
                class="scroll"
                :class="$style.textarea"
                :maxlength="1000"
                :placeholder="$t('list_profile__description_placeholder')"
              />
              <span :class="$style.descCounter">{{ description.length }}/1000</span>
            </div>
          </label>
        </div>
        <button type="button" :class="$style.coverEditor" :aria-label="$t('list_profile__select_cover')" @click="handleSelectCover">
          <img v-if="coverPreview" :class="$style.coverImg" :src="coverPreview" loading="lazy" decoding="async">
          <span v-else :class="$style.coverEmpty">
            <svg-icon name="plus" />
          </span>
          <span :class="$style.coverMask">{{ $t('list_profile__select_cover') }}</span>
        </button>
      </div>
      <footer :class="$style.footer">
        <base-btn :class="$style.btn" :disabled="!canSubmit" @click="handleSubmit">{{ $t('btn_save') }}</base-btn>
        <base-btn :class="$style.btn" outline @click="handleCancel">{{ $t('btn_cancel') }}</base-btn>
      </footer>
    </main>
  </material-modal>
</template>

<script>
import { computed, ref, watch } from '@common/utils/vueTools'
import { encodePath } from '@common/utils/common'
import { showSelectDialog } from '@renderer/utils/ipc'

const imageFilters = [
  {
    name: 'Image File',
    extensions: ['jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp', 'png', 'apng', 'avif', 'gif', 'svg', 'webp', 'bmp'],
  },
]

const buildLocalImageUrl = path => path ? `file:///${encodePath(path)}` : ''

export default {
  name: 'ListProfileEditModal',
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
    listInfo: {
      type: Object,
      default: null,
    },
    profile: {
      type: Object,
      default: () => ({}),
    },
  },
  emits: ['update:visible', 'submit'],
  setup(props, { emit }) {
    const name = ref('')
    const description = ref('')
    const coverUrl = ref('')
    const coverPreview = ref('')
    const isSaving = ref(false)
    const canSubmit = computed(() => name.value.trim().length > 0 && !isSaving.value)

    const initForm = () => {
      name.value = (props.listInfo?.name ?? '').substring(0, 40)
      description.value = (props.profile?.description ?? '').substring(0, 1000)
      coverUrl.value = props.profile?.coverUrl ?? ''
      coverPreview.value = coverUrl.value ? buildLocalImageUrl(coverUrl.value) : ''
      isSaving.value = false
    }

    watch(() => props.visible, visible => {
      if (visible) initForm()
    })

    const handleSelectCover = async() => {
      const result = await showSelectDialog({
        title: window.i18n.t('list_profile__select_cover'),
        properties: ['openFile'],
        filters: imageFilters,
      })
      if (result.canceled || !result.filePaths.length) return
      coverUrl.value = result.filePaths[0]
      coverPreview.value = buildLocalImageUrl(coverUrl.value)
    }

    const handleCancel = () => {
      if (isSaving.value) return
      emit('update:visible', false)
    }

    const handleNameInput = value => {
      if (value.length <= 40) return
      name.value = value.substring(0, 40)
    }

    const handleSubmit = async() => {
      const nextName = name.value.trim()
      if (!nextName || isSaving.value) return
      isSaving.value = true
      try {
        await new Promise((resolve, reject) => {
          emit('submit', {
            name: nextName.substring(0, 40),
            profile: {
              description: description.value.substring(0, 1000).trim(),
              coverUrl: coverUrl.value,
            },
            resolve,
            reject,
          })
        })
        emit('update:visible', false)
      } finally {
        isSaving.value = false
      }
    }

    return {
      name,
      description,
      coverPreview,
      canSubmit,
      handleCancel,
      handleNameInput,
      handleSelectCover,
      handleSubmit,
    }
  },
}
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.main {
  width: 100%;
  box-sizing: border-box;
  padding: 28px 32px 42px;
}
.title {
  font-size: 26px;
  font-weight: 700;
  margin-bottom: 28px;
  color: var(--color-font);
}
.content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 222px;
  gap: 38px;
  align-items: start;
}
.form {
  min-width: 0;
}
.field {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}
.descField {
  align-items: start;
}
.label {
  color: var(--color-font);
  font-size: 15px;
  line-height: 36px;
}
.inputWrap,
.textareaWrap {
  position: relative;
}
.input {
  width: 100%;
  box-sizing: border-box;
  padding-right: 58px !important;
}
.counter,
.descCounter {
  position: absolute;
  right: 12px;
  color: var(--color-font-label);
  font-size: 12px;
  pointer-events: none;
}
.counter {
  top: 50%;
  transform: translateY(-50%);
}
.textarea {
  width: 100%;
  height: 260px;
  box-sizing: border-box;
  resize: none;
  border: none;
  outline: none;
  border-radius: @form-radius;
  padding: 22px 20px 36px;
  color: var(--color-button-font);
  background-color: var(--color-primary-background);
  font-size: 15px;
  line-height: 1.55;
  transition: background-color .2s ease;

  &:hover,
  &:focus {
    background-color: var(--color-primary-background-hover);
  }
}
.descCounter {
  left: 20px;
  right: auto;
  bottom: 18px;
}
.coverEditor {
  position: relative;
  width: 222px;
  aspect-ratio: 1 / 1;
  border: none;
  padding: 0;
  border-radius: 16px;
  overflow: hidden;
  cursor: pointer;
  color: var(--color-primary);
  background-color: var(--color-primary-background);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .12), 0 12px 34px rgba(0, 0, 0, .1);
}
.coverImg {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.coverEmpty {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  font-size: 36px;
}
.coverMask {
  position: absolute;
  inset: auto 0 0;
  padding: 12px;
  color: #fff;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(0, 0, 0, .52));
  opacity: 0;
  transform: translateY(10px);
  transition: opacity .2s ease, transform .2s ease;
}
.coverEditor:hover .coverMask,
.coverEditor:focus-visible .coverMask {
  opacity: 1;
  transform: translateY(0);
}
.footer {
  display: flex;
  align-items: center;
  gap: 30px;
  margin: 34px 0 0 82px;
}
.btn {
  min-width: 122px;
}

@media (max-width: 760px) {
  .main {
    padding: 24px;
  }
  .content {
    grid-template-columns: 1fr;
  }
  .coverEditor {
    width: min(220px, 100%);
  }
  .footer {
    margin-left: 0;
  }
}
</style>
