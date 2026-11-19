/**
 * 媒体站要的四类能力 → 新播放器的插件列表（会 import .vue，所以和纯映射的 playerBridge.js 分开）。
 * 插件自己按 capabilities 判空，所以这里一律返回四个；对应能力不存在的插件不会挂载。
 */
import { qualityPlugin } from '../../../components/player/plugins/quality.js'
import { subtitlesPlugin } from '../../../components/player/plugins/subtitles.js'
import { markersPlugin } from '../../../components/player/plugins/markers.js'
import { spritePreviewPlugin } from '../../../components/player/plugins/spritePreview.js'

export function mediaPlugins() {
  return [qualityPlugin(), subtitlesPlugin(), markersPlugin(), spritePreviewPlugin()]
}
