<script setup>
/**
 * P5.37 控制栏图标：几何居中的内联 SVG。
 *
 * 为什么不再用字体字符（用户反馈 1「上下部切换图标未居中」的**根因**）：
 *   ⏮ ⏭ ▶ ⏸ ⏴ ⏵ 🔊 🔇 ⚙ ⛶ ⤢ 都不是「自带等宽字形盒」的字符 —— 浏览器从符号 / emoji 回退字体里
 *   取字形，而那个字形的**墨迹（ink）在 advance box 里本来就不居中**：左右留白不等，上下还被
 *   基线顶偏。flex 的 align-items / justify-content 居中的是**行盒**（advance box），不是墨迹，
 *   于是「按钮看起来居中、眼睛看到的图标偏左偏上」。这也解释了为什么靠 padding / line-height
 *   调不准：不同平台回退到不同字体，偏差方向都不一样（Segoe UI Symbol / Noto / Apple 各不相同）。
 *
 * 换成 SVG 之后这层不确定性直接消失：viewBox 恒为 0 0 24 24，**每个图形的墨迹 bbox 都关于
 * (12,12) 对称**（左右镜像成对、90° / 45° 绕中心旋转、齿距等距），按钮改用
 * grid + place-items:center，svg 本身是 display:block 的原子盒。
 * 于是「图标 bbox 中心 = 按钮中心」是**构造出来的**，不是调出来的（实测见 devtools/p537-player）。
 *
 * 约定：所有图形只用两种笔触 —— 实心（fill: currentColor）与描边（stroke: currentColor），
 * 每个图形的极值点都由上面的对称设计给出；新增图标时先确认「极值关于 (12,12) 对称」。
 */
defineProps({
  /** prev | play | pause | next | framePrev | frameNext | volume | mute | gear | fs | fsExit | caret | check */
  name: { type: String, required: true }
})
</script>

<template>
  <svg class="p-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    <!-- 上一条 ⏮：竖条 x 5..8 + 左三角 x 11..19 → 墨迹 x 5..19（中心 12）；y 5..19（中心 12） -->
    <template v-if="name === 'prev'">
      <rect x="5" y="5" width="3" height="14" rx="1" />
      <path d="M19 5v14l-8-7z" />
    </template>

    <!-- 下一条 ⏭：上一条的左右镜像 —— 对称性靠镜像关系保证 -->
    <template v-else-if="name === 'next'">
      <rect x="16" y="5" width="3" height="14" rx="1" />
      <path d="M5 5v14l8-7z" />
    </template>

    <!-- 播放 ▶：等腰三角形，底边 x=5、顶点 x=19 → 两轴中心都是 12 -->
    <path v-else-if="name === 'play'" d="M5 5v14l14-7z" />

    <!-- 暂停 ⏸：两根等宽竖条关于 x=12 对称（6..10 / 14..18），y 5..19 -->
    <template v-else-if="name === 'pause'">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </template>

    <!-- 上一帧 ⏴：小一号的左三角 x 7..17 / y 6..18（中心仍是 (12,12)） -->
    <path v-else-if="name === 'framePrev'" d="M17 6v12L7 12z" />

    <!-- 下一帧 ⏵ -->
    <path v-else-if="name === 'frameNext'" d="M7 6v12l10-6z" />

    <!-- 音量 🔊：喇叭 x 3.5..12.5 + 两根渐高的声波条（右极值 20.5）
         → 墨迹 x 3.5..20.5（中心 12）、y 5.5..18.5（中心 12） -->
    <template v-else-if="name === 'volume'">
      <path d="M3.5 9.5h4.5l4.5-4v13l-4.5-4H3.5z" />
      <rect x="15.6" y="8.6" width="2" height="6.8" rx="1" />
      <rect x="18.5" y="5.5" width="2" height="13" rx="1" />
    </template>

    <!-- 静音 🔇：同一个喇叭 + 一个叉（叉是两个绕 (18.15,12) 旋转 ±45° 的方块，
         旋转不改变中心 → 墨迹右极值 20.48，与左极值 3.5 关于 12 对称） -->
    <template v-else-if="name === 'mute'">
      <path d="M3.5 9.5h4.5l4.5-4v13l-4.5-4H3.5z" />
      <rect x="15.85" y="11" width="4.6" height="2" rx="1" transform="rotate(45 18.15 12)" />
      <rect x="15.85" y="11" width="4.6" height="2" rx="1" transform="rotate(-45 18.15 12)" />
    </template>

    <!-- 设置 ⚙：环形齿轮（evenodd 挖孔）+ 8 个齿（4 个轴对齐 + 4 个绕中心转 45°）。
         轴对齐的齿给出极值 3.2 / 20.8；旋转 45° 的齿落在内部（≈19.1），不改变 bbox -->
    <template v-else-if="name === 'gear'">
      <path
        fill-rule="evenodd"
        d="M12 5.8a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 1 0 0-12.4ZM12 9.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4Z"
      />
      <g>
        <rect x="10.8" y="3.2" width="2.4" height="3.4" rx="0.6" />
        <rect x="10.8" y="17.4" width="2.4" height="3.4" rx="0.6" />
        <rect x="3.2" y="10.8" width="3.4" height="2.4" rx="0.6" />
        <rect x="17.4" y="10.8" width="3.4" height="2.4" rx="0.6" />
      </g>
      <g transform="rotate(45 12 12)">
        <rect x="10.8" y="3.2" width="2.4" height="3.4" rx="0.6" />
        <rect x="10.8" y="17.4" width="2.4" height="3.4" rx="0.6" />
        <rect x="3.2" y="10.8" width="3.4" height="2.4" rx="0.6" />
        <rect x="17.4" y="10.8" width="3.4" height="2.4" rx="0.6" />
      </g>
    </template>

    <!-- 全屏 ⛶：四角括号。只写左上角一个 L，其余三个由绕 (12,12) 的 90° 旋转得到
         → 四重对称，极值 4 / 20 必然关于 12 对称 -->
    <template v-else-if="name === 'fs'">
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(90 12 12)" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(180 12 12)" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(270 12 12)" />
    </template>

    <!-- 退出全屏 ⤢：同四个括号 + 中央挖空的方框（描边），语义是「往里收」。
         括号部分与 fs 同一形状 → 极值同样 4 / 20；方框描边外沿 7.4..16.6 位于内部，不改变 bbox -->
    <template v-else-if="name === 'fsExit'">
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(90 12 12)" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(180 12 12)" />
      <path d="M4 4h6.6v2.5H6.5v4.1H4z" transform="rotate(270 12 12)" />
      <rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="2" />
    </template>

    <!-- 画质下拉的箭头（不是「居中的按钮图标」，只需要形状正确） -->
    <path
      v-else-if="name === 'caret'"
      d="M7.6 10.2 12 14.6 16.4 10.2"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />

    <!-- 选中项的对勾 -->
    <path
      v-else-if="name === 'check'"
      d="M5 12.6l4.3 4.2L19 6.6"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
/* 原子盒 + display:block：行内 SVG 会带基线间隙，正好是「偏上」的第二个来源 */
.p-ico {
  display: block;
  width: 18px;
  height: 18px;
  flex: none;
  pointer-events: none;
}
</style>
