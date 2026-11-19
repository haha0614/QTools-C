<template>
  <PluginMenuList :options="options" :value="player.state.rate" @pick="onPick" />
</template>

<script setup>
/** 倍速下拉：点倍速按钮直接出这一列，选完即生效并收起。 */
import PluginMenuList from './PluginMenuList.vue'

const props = defineProps({ player: { type: Object, required: true } })
const emit = defineEmits(['pick'])

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]
const options = RATES.map((r) => ({ value: r, label: r === 1 ? '1×（正常）' : r + '×' }))

function onPick(o) {
  props.player.setRate(o.value)
  emit('pick')
}
</script>
