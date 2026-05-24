<template>
  <button
    :class="[$style.btn, {[$style.min]: min}, {[$style.outline]: outline}]"
    tabindex="0"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<script>
export default {
  props: {
    min: {
      type: Boolean,
    },
    outline: {
      type: Boolean,
      default: false,
    },
    disabled: {
      type: Boolean,
      default: false,
    },
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';

.btn {
  display: inline-block;
  border: none;
  border-radius: @form-radius;
  cursor: pointer;
  padding: 8px 15px;
  color: var(--color-button-font);
  outline: none;
  transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  background-color: var(--color-button-background);
  font-size: 14px;
  box-shadow: 0 6px 16px rgba(31, 38, 35, 0.06);
  &[disabled] {
    opacity: .4;
    cursor: default;
  }

  &.outline {
    background-color: transparent;
  }

  &:hover {
    background-color: var(--color-button-background-hover);
    box-shadow: 0 8px 20px rgba(31, 38, 35, 0.1);
  }
  &:active {
    background-color: var(--color-button-background-active);
    transform: translateY(1px);
  }
}

.min {
  padding: 3px 8px;
  font-size: 12px;
}

</style>
