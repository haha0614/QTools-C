<template>
  <PluginMenuList :options="options" :value="ctx.player.state.rate" @pick="onPick" />
</template>

<script setup>
/**
 * 倍速菜单段（内核自带，不是插件）：直接选，不再"点一下切一档"。
 */
import PluginMenuList from './PluginMenuList.vue'

const props = defineProps({ ctx: { type: Object, required: true } })

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
const options = RATES.map((r) => ({ value: r, label: r === 1 ? '1×（正常）' : r + '×' }))

function onPick(o) {
  props.ctx.player.setRate(o.value)
  props.ctx.closeMenu()
}
</script>
