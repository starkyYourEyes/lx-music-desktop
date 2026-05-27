<template>
  <div :class="$style.loginOverlay">
    <div :class="$style.loginPanel">
      <button :class="$style.closeBtn" type="button" @click="$emit('close')">x</button>
      <div :class="$style.qrWrap">
        <img v-if="qrImg" :src="qrImg" draggable="false">
        <span v-else>{{ isCreatingQr ? '生成中...' : '暂无二维码' }}</span>
      </div>
      <h3>登录</h3>
      <p>{{ qrStatusText }}</p>
      <base-btn min :disabled="isCreatingQr" @click="$emit('refresh')">重新获取二维码</base-btn>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  qrImg: string
  qrStatusText: string
  isCreatingQr: boolean
}>()

defineEmits<{
  close: []
  refresh: []
}>()
</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.loginOverlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background-color: rgba(20, 28, 31, .28);
  backdrop-filter: blur(8px);
}

.loginPanel {
  position: relative;
  width: min(360px, 100%);
  text-align: center;
  padding: 28px;
  box-sizing: border-box;
  border-radius: 8px;
  background-color: var(--color-main-background);
  border: 1px solid rgba(128, 128, 128, .14);
  box-shadow: 0 18px 42px rgba(31, 38, 35, .18);

  h3 {
    margin: 18px 0 8px;
    font-size: 18px;
    color: var(--color-font);
  }

  p {
    margin: 0 0 16px;
    min-height: 20px;
    font-size: 13px;
    line-height: 1.5;
    color: var(--color-font-label);
  }
}

.closeBtn {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 28px;
  height: 28px;
  border: 0;
  padding: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-font-label);
  font-size: 22px;
  line-height: 28px;
  cursor: pointer;
  transition: color @transition-normal, background-color @transition-normal;

  &:hover {
    color: var(--color-font);
    background-color: rgba(0, 0, 0, .08);
  }
}

.qrWrap {
  width: 218px;
  height: 218px;
  margin: 0 auto;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fff;
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, .1);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-font-label);

  img {
    display: block;
    width: 100%;
    height: 100%;
  }
}
</style>
