<template>
  <div class="qtp-list">
    <button
      v-for="o in options" :key="String(o.value)" type="button"
      class="qtp-opt" :class="{ on: o.value === value }"
      @click="emit('pick', o)"
    >{{ o.label }}</button>
  </div>
</template>

<script setup>
/**
 * 插件共用的菜单列表（画质 / 字幕都用它）。
 * 只负责"渲染一列单选"，点谁由插件自己接。
 */
defineProps({
  options: { type: Array, default: () => [] },
  value: { type: [String, Number], default: '' }
})
const emit = defineEmits(['pick'])
</script>

<style lang="scss" scoped>
.qtp-list { display: flex; flex-direction: column; gap: 2px; }
.qtp-opt {
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
}
.qtp-opt:hover { background: rgba(255, 255, 255, .12); }
.qtp-opt.on { background: rgba(74, 158, 255, .22); color: #cfe6ff; }
</style>
