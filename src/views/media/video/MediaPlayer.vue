<!--
  MediaPlayer.vue —— 播放层（app.js 播放器部分的等价实现）
  覆盖：进度记忆与续播、清晰度切换（原画直连 / 实时转码 + 内容偏移）、原画与转码统一的自绘控制条
        （播放/暂停 · 进度 · 时间 · 音量 · 画质 · 上一部/下一部 · 全屏，两种模式同一套 UI，不再使用原生 controls）、
        进度条悬停 / 拖动共用的预览浮层（pv2 片段，无则降级精灵图）、seek（转码重开流 + pendingSeek / 原画直写 currentTime）、
        上一个 / 下一个、收藏、字幕轨注入、异常编码回退、播放器会话式 play 埋点与 play_end 结算。
   P4.4：全屏下控制条 2.5s 无操作自动淡出（判定在 playerExtras.createCtrlAutoHide），
        进度条 / 标记轨 / 刻度层 / 浮层锚点统一按「轨道几何」（两端各半个 thumb）换算。
  约定：面板状态（当前视频 / 上一部下一个可用性 / 收藏 / 清晰度）由 VideoPage 持有，本组件通过 props 接收、
        emit 回传，不直接读写 localStorage 与服务端。
  事件监听全部通过模板绑定，组件卸载时由 Vue 自动解绑，不会残留 <video> 监听（原页手动管理 el.video）。
-->
<template>
  <div class="player" role="dialog" aria-modal="true" aria-label="播放器">
    <!-- P5.24-A 头部：标题（加粗、单行省略）+ 一行中点分隔的元信息 + 右侧三组按钮。
         分组由 .p-act-group 承担，组间 .p-act-sep 画 1px 竖线；按钮高度 / 圆角 / 内边距统一由
         .p-actions .btn 定义，宽度不再随文案长短跳动。 -->
    <div class="p-head">
      <div class="p-info">
        <h2 class="p-title" :title="video.title">{{ video.title }}</h2>
        <div class="p-meta">
          <span class="p-meta-i" title="所在目录">目录 {{ video.folder }}</span>
          <span class="p-meta-i" title="影片时长">时长 {{ fmtDur(video.dur) }}</span>
          <span class="p-meta-i" title="分辨率与画质档">
            分辨率 {{ video.w && video.h ? video.w + '×' + video.h : '未知' }} {{ resBadge(video.w) }}
          </span>
          <span class="p-meta-i" title="视频编码">编码 {{ video.vcodec || '未知' }}</span>
          <span class="p-meta-i" title="文件体积">体积 {{ fmtSize(video.size) }}</span>
          <span class="p-meta-i" title="是否带字幕">字幕 {{ video.sub ? '有' : '无' }}</span>
        </div>
      </div>
      <div class="p-actions" role="group" aria-label="播放页操作">
        <div class="p-act-group">
          <button
            class="btn p-fav"
            :class="{ on: fav }"
            type="button"
            :aria-pressed="fav"
            :aria-label="fav ? '取消收藏' : '收藏'"
            title="收藏 / 取消收藏（快捷键 S）"
            @click="emit('toggle-fav')"
          >
            {{ fav ? '★ 已收藏' : '☆ 收藏' }}
          </button>
        </div>
        <span class="p-act-sep" aria-hidden="true"></span>
        <div class="p-act-group">
          <button class="btn" type="button" :disabled="!hasPrev" title="上一部（快捷键 P）" @click="emit('prev')">
            ‹ 上一部
          </button>
          <button class="btn" type="button" :disabled="!hasNext" title="下一部（快捷键 N）" @click="emit('next')">
            下一部 ›
          </button>
        </div>
        <span class="p-act-sep" aria-hidden="true"></span>
        <div class="p-act-group">
          <button class="btn btn-primary p-close" type="button" title="关闭播放器（Esc）" @click="emit('close')">
            关闭 <span class="p-kbd" aria-hidden="true">Esc</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="warnVisible" class="p-warn">该片为 HEVC/异常编码，浏览器可能无法播放</div>

    <div class="p-body">
      <div class="p-main">
        <!-- P4.3 全屏容器：把 <video>（.p-stage）与自绘控制栏（.p-ctrl）包在一起，
             全屏请求发到这一层 —— 只对 .p-stage 全屏时控制栏是兄弟节点，会被挡在屏幕外。 -->
        <div
          ref="fsEl"
          class="p-fs-wrap"
          :class="{ 'is-ctrl-hidden': ctrlHidden }"
          @mousemove="onUserActivity"
          @mousedown="onUserActivity"
          @touchstart.passive="onUserActivity"
          @mouseenter="onStageEnter"
          @mouseleave="onStageLeave"
        >
          <div ref="stageEl" class="p-stage">
            <!-- 原画与转码都不再挂原生 controls：控制条统一用下方自绘 .p-ctrl -->
            <video
              ref="videoEl"
              autoplay
              playsinline
              preload="metadata"
              @click="onVideoClick"
              @play="onPlay"
              @playing="onPlaying"
              @loadeddata="onLoadedData"
              @loadedmetadata="onLoadedMetadata"
              @durationchange="onDurationChange"
              @volumechange="onVolumeChange"
              @timeupdate="onTimeUpdate"
              @webkitbeginfullscreen="onIosFsIn"
              @webkitendfullscreen="onIosFsOut"
              @pause="onPause"
              @ended="onEnded"
              @seeking="onSeeking"
              @canplay="onCanPlay"
              @error="onError"
            >
              <track v-if="subSrc" :key="subSrc" kind="subtitles" label="字幕" srclang="zh" default :src="subSrc" />
            </video>
            <!-- P5.17 转码档防黑屏覆盖层 / P5.20 内容换成「canvas 冻结当前画面」
                 转码流是服务端边转边推的分片 MP4（seekable=[0,0]），重挂流到首帧之间是空 buffer。
                 P5.20 起这层不再等取帧接口（那是 100-400ms 的空窗 + 一张 480 宽的放大图），
                 而是换流前用 canvas 把**当前显示的像素**画下来：0 请求、尺寸=舞台显示尺寸、0 放大。
                 新流 canplay 后淡出移除；取帧失败静默退回冻结图（@error），不弹任何错。
                 data-cover-origin 供证据脚本断言「这一帧是冻结图（freeze）还是取帧图（frame）」。 -->
            <img
              v-if="coverOn"
              ref="coverEl"
              class="p-stream-cover"
              :class="{ 'p-cover-out': coverFading }"
              :data-cover-origin="coverOrigin"
              :data-cover-w="coverFrameW"
              :src="coverSrc"
              alt=""
              aria-hidden="true"
              @error="onCoverError"
            />
            <!-- P5.18 转码档拖动「画面跟随」层：转码流在浏览器里不可 seek（seekable=[0,0]），
                 拖动时改写 currentTime 是无效的，所以把**目标位置的帧**铺满整个舞台（不是只在小浮层里）。
                 与 .p-stream-cover 同一套定位（绝对铺满 + object-fit:contain + 黑底），
                 父级尺寸不再依赖 video 的临时 videoWidth/videoHeight（见 .p-stage video / .p-fs-wrap 的 P5.18 注释）。 -->
            <img
              v-if="scrubOn"
              ref="scrubCoverEl"
              class="p-scrub-cover"
              :src="scrubSrc"
              alt=""
              aria-hidden="true"
              @error="scrubOn = false"
            />
            <!-- P5.19 拖动跟随层的帧号：跟随帧是一张静止图，没有时间码就不知道拖到了哪一帧。
                 绝对定位（不参与 .p-stage 的 flex 布局 → 舞台定高不变）、pointer-events:none（不挡点击暂停），
                 与进度条右侧同一条口径（frameTimecode，缺帧率时退化成 mm:ss）。 -->
            <span v-if="scrubOn" class="p-scrub-tc" :title="seekNowTitle">{{ frameTimecode(seekPos, frameFps) }}</span>
            <button v-if="tapVisible" class="p-tap" type="button" @click="onTapPlay">▶ 点击播放</button>
            <button v-if="restartVisible" class="p-restart" type="button" @click="onRestart">从头播放</button>
          </div>

          <!-- 自绘控制条：原画（直连）与转码共用一套 UI，原画模式不再使用浏览器原生 controls -->
          <div
            ref="ctrlEl"
            class="p-ctrl"
            @mouseenter="onCtrlPointerEnter"
            @mouseleave="onCtrlPointerLeave"
            @focusin="onCtrlFocusIn"
          >
            <!-- P5.24-A 控制栏三组布局（用户反馈 3 / 5）：左（播放 / 音量 / 时间码）·
                 中（进度条 + 标记轨 + AB 读数，唯一可伸缩的东西）· 右（逐帧 / 前后跳 / 设置 / 全屏）。
                 一级可见按钮固定 8 个，其余全部收进 ⚙ 设置浮层（PlayerSettings.vue）：
                 倍速 / 增益 / 画质 / 字幕 / AB / 标记列表 / 快捷键说明。功能只换位置，一个都没删。 -->
            <div class="p-ctrlline">
              <div class="p-grp p-grp-left">
                <button
                  class="p-btn p-btn-play"
                  type="button"
                  :aria-label="isPlaying ? '暂停' : '播放'"
                  title="播放 / 暂停（空格）"
                  @click="togglePlay"
                >
                  {{ isPlaying ? '⏸' : '▶' }}
                </button>
                <button
                  class="p-btn"
                  type="button"
                  :aria-label="muted || volume === 0 ? '取消静音' : '静音'"
                  :title="muted || volume === 0 ? '取消静音（M）' : '静音（M）'"
                  @click="toggleMute"
                >
                  {{ muted || volume === 0 ? '🔇' : '🔊' }}
                </button>
                <!-- 音量滑块：窄屏让位给静音按钮（既有规则不变） -->
                <input
                  class="p-vol"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  :value="muted ? 0 : volume"
                  aria-label="音量"
                  title="音量（↑ / ↓）"
                  @input="onVolumeInput"
                />
                <!-- P5.19：时间码**一直**显示帧号（位置 hh:mm:ss:ff / 总时长），
                     文案由 playerExtras.seekTimecodeText 一处生成；缺帧率的片退化成 mm:ss。
                     P5.24-A：从进度条右侧挪到左侧控制组，并把时间码常显的区域从本行起点算起，
                     于是「左侧 = 播放 / 音量 / 时间」与参考图的信息层级一致。 -->
                <span class="p-seek-now" :class="{ 'is-frame': hasFps }" :title="seekNowTitle">{{ seekNowText }}</span>
              </div>

              <div class="p-grp p-grp-mid">
                <div class="p-seek-col" :style="seekVars">
                  <!-- mousemove 挂在 20px 高的容器上，命中带比 4px 轨道宽，指针略偏也能触发。
                       P5.2 修复：这里必须是「逗号表达式」而不是 [a, b] —— 数组字面量会被编译成
                       ($event) => [onSeekHover, onMarkerHover]，即「一个返回数组的函数」，Vue 只调用它一次
                       并丢弃返回值，两个处理器都不会执行（P4-B 起 hover 预览从未触发的真正原因）。 -->
                  <div
                    class="p-seekwrap"
                    @mousemove="onSeekHover($event), onMarkerHover($event)"
                    @mouseleave="onSeekLeave($event), onMarkerLeave($event)"
                  >
                    <!-- P4-B 标记刻度：单点是 2px 竖线，区间是一段浅色带；hover 出 'mm:ss–mm:ss · 说明' 原生提示。
                         pointer-events:none 让鼠标照常落到下面的 range 上（既不挡 hover 预览，也不挡拖动） -->
                    <div v-if="markerTickList.length" class="p-marks" aria-hidden="true">
                      <span
                        v-for="t in markerTickList"
                        :key="t.key"
                        class="p-mark"
                        :class="{ 'is-range': t.width > 0 }"
                        :style="markerTickStyle(t)"
                        :title="t.title"
                      ></span>
                    </div>
                    <input
                      ref="seekEl"
                      class="p-seek"
                      :class="{ 'is-frame': hasFps }"
                      type="range"
                      min="0"
                      :max="seekMax"
                      :step="seekStep"
                      :value="seekPos"
                      :style="seekFillStyle"
                      :title="seekTipText || seekTitle"
                      aria-label="播放位置"
                      :aria-valuetext="seekAriaText"
                      @pointerdown="onSeekPointerDown"
                      @input="onSeekInput"
                      @change="onSeekCommit"
                      @keydown="onSeekKey"
                    />
                    <!-- P5.16 精细拖动提示：pointer-events:none 不挡拖动 / hover 浮层；移动端无 Shift，整块不渲染 -->
                    <div v-if="seekTipText" class="p-fine-tip" :class="{ on: fineDragging }">{{ seekTipText }}</div>
                    <!-- P4-B 标记刻度提示：hover 到刻度附近（单点 ±1.2%、区间整段）时在刻度上方显示 'mm:ss–mm:ss · 说明'。
                         刻度本身 pointer-events:none，所以不会挡 range 的 hover 预览与拖动 -->
                    <div v-if="markerHover" class="p-marker-tip" :style="floatStyle(markerHover.left / 100)">
                      {{ markerHover.title }}
                    </div>
                    <!-- 1px 指示线：与浮层同源比例，告诉用户这里能 hover；无预览资源时不渲染 -->
                    <div v-if="hoverLineVisible" class="p-hover-line" :style="hoverLineStyle"></div>
                    <!-- P5.2 悬停 / 拖动共用的**同一个**浮层（不会出现两个浮层叠加）：
                         有 pv2 → 预览片段视频；无 pv2 但有精灵图 → 精灵图切片（降级）；两者都无 → 整块不渲染。
                         v-if 绑 previewMode：没资源时不进 DOM；v-show 绑预览开关：同一部片只创建一次 <video>，
                         离开进度条只是隐藏，回到条上不会重新 load（preload="none"，第一次需要时才 load）。 -->
                    <div
                      v-if="previewMode"
                      v-show="previewShown"
                      class="p-preview"
                      :class="[previewClass, { 'is-frame-ready': clipFrameReady }]"
                      :style="floatStyle(previewRatio)"
                    >
                      <video
                        v-if="previewMode === 'clip'"
                        ref="clipEl"
                        class="p-preview-v"
                        muted
                        playsinline
                        preload="none"
                        :src="previewSrc"
                        @loadedmetadata="onClipMetadata"
                        @loadeddata="onClipFrameReady"
                        @seeked="onClipFrameReady"
                      ></video>
                      <div v-else class="p-hover-img" :style="spriteStyle"></div>
                      <!-- P5.15 精确帧：盖在上面的精灵图切片 / 预览片段之上。
                           精灵图一格铺 400 格，2 小时片一格 ≈18 秒，只能当零延迟兜底；
                           debounce 250ms 后向 /media/frame 取真帧，到了就盖上这里（右上角一个指示点，P5.21）。
                           失败（400/404/503）时这一层不渲染 → 用户看到的还是精灵图切片，不弹任何错。 -->
                      <div v-if="frameExact" class="p-hover-exact" :style="frameImgStyle"></div>
                      <!-- P5.21：真帧指示从文字徽标改成一个小圆点 —— 视觉上不占字面，语义留在 aria-label/title 上 -->
                      <span
                        v-if="frameExact"
                        class="p-preview-exact"
                        role="img"
                        aria-label="精确帧"
                        title="精确帧"
                      ></span>
                      <!-- 底部时间条（P5.19）：大字是**带帧号的影片内容时间**（00:03:21:08），小字才是片段内部时间
                           （片段 0:07 / 0:08），见 PreviewTimeBar.vue。z-index 3 → 压在 .p-hover-exact 精确帧之上，
                           所以「精确帧浮层」看到的时间码同样是带帧号的那一条。 -->
                      <PreviewTimeBar :sec="previewInfo.labelSec" :fps="frameFps" :caption="previewCaptionText" />
                    </div>
                  </div>
                  <!-- P4.1 标记轨（marker lane）：进度条下方独立一条，间距 var(--lane-gap)=3px（P4.3 起的值）。
                        P4.4：左右内缩半个 thumb 后与进度条的可视轨道同宽，标记 left% 与滑块中心同源。
                       单点 = 3px 通高竖条；区间 = 半透明色带 + 左右各 2px 实心边。
                       轨道本身 pointer-events:none（不挡拖动与 hover 预览），只有标记可点：
                       点一下跳到 pos，区间再点一下跳到 endPos；hover/focus 复用 .p-marker-tip 提示。
                       无标记时整条不渲染（v-if），不留空白。 -->
                  <div
                    v-if="markerTickList.length"
                    class="p-marklane"
                    role="group"
                    aria-label="进度标记"
                    :style="laneVars"
                  >
                    <button
                      v-for="t in markerTickList"
                      :key="'ln' + t.key"
                      class="p-lane-mark"
                      :class="{ 'is-range': t.isRange }"
                      type="button"
                      :style="laneMarkStyle(t)"
                      :title="t.title"
                      :aria-label="'跳到 ' + t.title"
                      @mouseenter="onLaneHover(t)"
                      @mouseleave="onLaneLeave"
                      @focus="onLaneHover(t)"
                      @blur="onLaneLeave"
                      @click.stop="onLaneClick(t)"
                    ></button>
                  </div>
                </div>
                <!-- AB 读数（被动指示，不是按钮）：A / B 两个按钮已收进设置浮层，
                     这里只留一行状态，点位与循环状态仍然一眼可见（用户要求的「中部含 AB 标记」）。 -->
                <span class="p-ab-text" :class="{ on: abOn }" :title="abTitle">{{ abText }}</span>
              </div>

              <div class="p-grp p-grp-right">
                <!-- P4-B 逐帧：暂停态单帧步进（1/30 近似，有 requestVideoFrameCallback 时按实测帧间隔） -->
                <span class="p-frame">
                  <button class="p-btn" type="button" aria-label="上一帧" title="上一帧（快捷键 , 或 Shift+←）" @click="stepFrame(-1)">⏴</button>
                  <button class="p-btn" type="button" aria-label="下一帧" title="下一帧（快捷键 . 或 Shift+→）" @click="stepFrame(1)">⏵</button>
                </span>
                <span v-if="hasPrev || hasNext" class="p-sep" aria-hidden="true"></span>
                <button v-if="hasPrev" class="p-btn" type="button" aria-label="上一部" title="上一部（快捷键 P）" @click="emit('prev')">⏮</button>
                <button v-if="hasNext" class="p-btn" type="button" aria-label="下一部" title="下一部（快捷键 N）" @click="emit('next')">⏭</button>
                <span class="p-sep" aria-hidden="true"></span>
                <!-- 设置：倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键说明都收在这个齿轮里。
                     data-qt-gear 是证据脚本的锚点（点它 = 走真实事件链打开面板）。 -->
                <button
                  ref="gearEl"
                  data-qt-gear
                  class="p-btn p-gear"
                  :class="{ on: settingsOpen }"
                  type="button"
                  aria-label="播放设置"
                  :aria-expanded="settingsOpen"
                  title="播放设置：倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键"
                  @click="toggleSettings"
                >
                  ⚙
                </button>
                <button
                  data-qt-fs
                  class="p-btn"
                  type="button"
                  :aria-label="fsActive ? '退出全屏' : '全屏'"
                  :title="fsActive ? '退出全屏（F）' : '全屏（F）'"
                  @click="toggleFullscreen"
                >
                  {{ fsActive ? '⤢' : '⛶' }}
                </button>
              </div>
            </div>

            <!-- P5.24-A 设置浮层：纯展示组件，只吃「当前值 + 选项 + 文案」并 emit 意图；
                 所有取值口径（档位 / 文案 / title）仍由本文件一处生成，行为与收纳前逐字一致。 -->
            <PlayerSettings
              v-if="settingsOpen"
              ref="settingsEl"
              :speed="speedLevel"
              :speed-options="speedOptions"
              :speed-title="speedTitle"
              :gain="gainLevel"
              :gain-title="gainTitle"
              :gain-fallback="gainFallback"
              :gain-note="gainNote"
              :quality="curQ"
              :quality-options="qualityOptions"
              :quality-hint="qHintVisible"
              :sub-show="hasSub"
              :sub-visible="subVisible"
              :ab-a="abA"
              :ab-b="abB"
              :ab-text="abText"
              :ab-title="abTitle"
              :ab-on="abOn"
              :markers="markerTickList"
              :help-open="helpVisible"
              @update:speed="setSpeed"
              @gain="cycleGain"
              @update:quality="onQualityPick"
              @toggle-sub="toggleSubVisible"
              @ab="setAbPoint"
              @clear-ab="clearAb"
              @pick-marker="onMarkPick"
              @help="toggleHelp"
            />
          </div>
        </div>

      </div>

      <!-- P5.23 右侧常驻信息栏：原信息抽屉的内容常驻于此（结构不动，只换容器）。
           桌面 = 静态列（不覆盖视频、自己纵向滚动）；窄屏 = 浮层（滑出覆盖视频，不挤压它）。 -->
      <aside
        class="p-side"
        :class="{ 'is-closed': !sideOpen, 'is-float': isNarrow }"
        aria-label="视频信息"
        @mouseenter="sideAreaHover = true"
        @mouseleave="sideAreaHover = false"
      >
        <slot name="side"></slot>
      </aside>

      <!-- 窄屏浮层展开时的遮罩：点一下收起（桌面常驻列不会有它） -->
      <div v-if="isNarrow && sideOpen" class="p-side-scrim" @click="closeSide"></div>

      <!-- P5.24 唯一的信息栏开关（用户反馈 1 / 2）：不再有「头部 › 收起」+「右侧竖向把手 展开」两套 UI。
           贴在信息栏左边缘中部的一条竖向短条，图标只有一个 chevron：
             展开态 ›（指向右 = 收起）、收起态 ‹（指向左 = 展开）；
           P5.24-A（用户反馈「肯定要移动的呀，不然飘在视频上面干嘛」）：按钮**跟着栏走** ——
             展开态 right: var(--p-side-w)（贴栏左边缘），收起态 right: 0（贴视频右边缘）；
             两态只差水平位置，y / 宽 / 高不变，靠 transition 平滑滑动而不是瞬移。
             不改原落点的话，收起后栏宽归零、视频变宽，按钮会浮在画面中间（实测距右边缘 412px）。
           默认半透明，指针移入信息栏或按钮本身才浮到不透明，移出即淡回（不动视频，拖动时不闪）。 -->
      <button
        class="p-side-toggle"
        :class="{ 'is-shown': sideHover, 'is-open': sideOpen }"
        type="button"
        data-role="side-toggle"
        :aria-pressed="sideOpen"
        :aria-label="sideOpen ? '收起信息栏' : '展开信息栏'"
        :title="sideOpen ? '收起信息栏' : '展开信息栏'"
        @mouseenter="onSideToggleHover(true)"
        @mouseleave="onSideToggleHover(false)"
        @click="onSideToggle"
      >
        <span class="p-side-toggle-i" aria-hidden="true">{{ sideOpen ? '›' : '‹' }}</span>
      </button>
    </div>

    <!-- P4-B 快捷键总表：控制条上的 ? 按钮或键盘 ? 打开；Esc 先关浮层（见 VideoPage.onKey 的 Escape 分支） -->
    <div v-if="helpVisible" class="p-help" role="dialog" aria-modal="false" aria-label="快捷键说明" @click.self="helpVisible = false">
      <div class="p-help-box">
        <h3 class="p-help-h">快捷键 / 操作</h3>
        <ul class="p-help-list">
          <li v-for="row in SHORTCUTS" :key="row.k">
            <b class="p-help-key">{{ row.k }}</b>
            <span class="p-help-val">{{ row.v }}</span>
          </li>
        </ul>
        <p class="p-help-note">
          A/B 循环与逐帧都在「内容时间」上工作：转码模式会自动换算上流起点，与进度记忆、画质切换互不影响。
        </p>
        <button class="btn" type="button" @click="helpVisible = false">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaApi } from '@/composables/useMediaApi'
// P4-B：AB 循环 / 逐帧 / 增益 / 标记刻度的纯逻辑（无 DOM，可单独单测）
// P4.1：+ 视频倍速档位与持久化、增益档位循环、标记轨尺寸与点击目标
import {
  FRAME_FALLBACK_SEC,
  HOVER_PREVIEW_MIN_MS,
  LANE_EDGE_PX,
  LANE_GAP_PX,
  LANE_HEIGHT_PX,
  LANE_HEIGHT_PX_MOBILE,
  LANE_PIN_PX,
  LANE_RANGE_MIX_PCT,
  LANE_RAISE_PX,
  SPEED_LEVELS,
  abActive,
  abPress,
  abTick,
  applyGain,
  blurActiveInCtrl,
  clipCaption,
  clipSeekStep,
  createCtrlAutoHide,
  createGainGraph,
  createProgressClock,
  createRafSeek,
  createSeekTextThrottle,
  createThrottle,
  durText,
  fineDelta,
  FINE_DRAG_ZOOM,
  frameOf,
  frameStep,
  frameStepSize,
  frameTimecode,
  frameToSec,
  halfFrameSec,
  normFps,
  sameFrame,
  shouldSeekWrite,
  snapToFrame,
  timecode,
  markJumpTarget,
  markerTicks as buildMarkerTicks,
  nextGain,
  normalizeGain,
  normalizeSpeed,
  pointerInCtrlZone,
  progressGate,
  readGainLevel,
  readSpeedLevel,
  seekPxToRatio,
  seekPreview,
  seekRatioCss,
  seekTimecodeText,
  seekTimecodeTitle,
  seekThumbPx,
  seekTrackGeom,
  speedLabel,
  speedStep,
  writeGainLevel,
  writeSpeedLevel
} from './playerExtras'
// P5.15：hover 精确帧的调度（debounce 250ms / LRU 60 张 / 同秒去重 / 失败静默回退，纯逻辑可单测）
import { createFramePicker, frameSecond } from './framePicker'
// P5.19：浮层底部时间条（大字改成带帧号的 hh:mm:ss:ff，SSR 可渲染验证）
import PreviewTimeBar from './PreviewTimeBar.vue'
// P5.20：换流时把「当前画面」冻结成 canvas 覆盖层（0 请求 / 不放大），取帧只作兜底
import { coverFrameWidth, coveredSwitch, freezeElementFrame } from './coverFreeze'
// P5.24-A：「设置」浮层（倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键）拆成纯展示组件
import PlayerSettings from './PlayerSettings.vue'

const props = defineProps({
  /** 当前播放的视频对象 */
  video: { type: Object, required: true },
  /** 续播秒数（打开时由页面从 localStorage 读出） */
  startPos: { type: Number, default: 0 },
  /** 页面每次调用 openPlayer 自增；同一部片重开也算新会话 */
  openSeq: { type: Number, default: 0 },
  hasPrev: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
  fav: { type: Boolean, default: false },
  /** 清晰度档位：orig | 720 | 480 | 360（页面持久化在 localStorage['ms.q']） */
  quality: { type: String, default: 'orig' },
  /**
   * 播放会话埋点方法（由页面从 useMediaTrack 单例传入）：
   * { openPlaySession, trackPlayStart, trackPlayEnd }。
   * 播放层不自己调 useMediaTrack()——那样会在播放器卸载时 dispose 页面级的 pagehide 监听。
   */
  tracker: { type: Object, required: true },
  /** P4-B：该片的标记列表（信息抽屉 emit 上来），用于进度条刻度；空数组 = 不画刻度 */
  markers: { type: Array, default: () => [] }
})

const emit = defineEmits([
  'close',
  'prev',
  'next',
  'toggle-fav',
  'update:quality',
  'save-pos',
  'clear-pos',
  'push-recent',
  'open-meta'
])

const api = useMediaApi()

const Q_VALUES = ['orig', '720', '480', '360']
const Q_LABELS = { orig: '原画', 720: '720p', 480: '480p', 360: '360p' }

const videoEl = ref(null)
const stageEl = ref(null)
/** P4.3：全屏元素 = 包裹 <video> + 自绘控制栏的容器（只对 .p-stage 全屏会让控制栏消失） */
const fsEl = ref(null)
/** P4.4：控制条元素（自动隐藏的「指针是否还停在控制条上」兜底判定用） */
const ctrlEl = ref(null)
const tapVisible = ref(false)
const warnVisible = ref(false)
const restartVisible = ref(false)
const qHintVisible = ref(false)
const seekPos = ref(0)
const seekDur = ref(0)
const seekMax = ref(1)
/**
 * P5.16 帧率：来自 /api/media/index 的 media_video.fps（由 doc/media_fps.sql + enrich-meta.js 回填）。
 * 0 = 不知道（老库未回填 / 探测失败）→ 全部行为退回 P5.15：按整秒拖动、不吸帧、不显示帧号。
 */
const frameFps = computed(() => normFps(props.video && props.video.fps))
const hasFps = computed(() => frameFps.value > 0)
/** 进度条步长：知道帧率就按「一帧」走（否则永远落不到某一帧），不知道时保持整秒 */
const seekStep = computed(() => (hasFps.value ? 1 / frameFps.value : 1))
/* P5.19：原来给模板用的「拖动中」响应式镜像 seekDragging 已删除 —— 时间码不再区分拖动 / 静止，
   模板里没有第二个消费者；真正的拖动状态仍是 qSeekDragging（控制条自动隐藏状态机用）。 */
/** 自绘控制条用的状态镜像（真值仍以 <video> 为准，事件里同步） */
const isPlaying = ref(false)
const volume = ref(1)
const muted = ref(false)
const fsActive = ref(false)

/** 当前清晰度：props.quality 的内部镜像，切换时可同步生效（不必等父级下一帧） */
const curQ = ref(Q_VALUES.indexOf(props.quality) >= 0 ? props.quality : 'orig')
const isTranscode = computed(() => curQ.value !== 'orig')

/** 转码流的内容起点（秒）：片内 currentTime 是相对它的偏移（app.js:1023-1025） */
let streamStart = 0
let pendingSeek = 0
let qSeekDragging = false
let qFallback = false
let lastQSrcAt = 0
let lastPosWrite = 0
let lastRecentPush = 0
let qHintTimer = 0
let openedVideo = null

/* ------------------------------------------------- 进度条 hover / 拖动预览 */
/* 派生资源（精灵图 / 预览视频）默认不生成，后端 /media/index 给出 hasSprite / hasPreview，
   不可用时这里一律不发请求、不显示浮层，交互与原来完全一致。 */

/** 精灵图固定 20 列 × 20 行、每格 160×90（build-thumbs.js SPRITE，成品 3200×1800）
    P5.14：10×10 → 20×20（一格覆盖的影片时长从 /100 压到 /400）。产物文件名不变，
    所以常量改成 20 之后必须整库重生成过精灵图，旧 10×10 产物会整体切错帧。 */
const SPRITE_COLS = 20
const SPRITE_ROWS = 20
const SPRITE_CELLS = SPRITE_COLS * SPRITE_ROWS

const clipEl = ref(null)
const seekEl = ref(null)
/**
 * P5.14：浮层**只在悬停（未按下）时**出现，拖动中不再显示 —— 拖动时视频画面本身就跟手
 * （原画档 onSeekInput 直接写 currentTime），浮层只是把同一件事再重复一遍，还挡住进度与时间码。
 * 状态因此收敛成三个（原来的 previewSource：hover / drag 已不需要）：
 * - previewMode：'' 不显示 / 'clip' 预览片段（有 pv2）/ 'sprite' 精灵图切片（无 pv2 的降级）
 * - previewOn：显示开关（落到 v-show）；previewMode 为空时整块不进 DOM
 * - previewRatio：浮层锚点比例（0–1），内容时间标签与片段 seek 都由它算（见 playerExtras.seekPreview）
 */
const previewMode = ref('')
const previewOn = ref(false)
const previewRatio = ref(0)
/** 预览片段自身时间（秒）：只喂给浮层底部的小字「片段 0:03 / 0:08」，不再当进度显示 */
const clipTime = ref(0)
let clipDur = 0
/** 片段取片是否已经发起过：preload="none" 下 readyState 恒为 0，只允许 load() 一次（见 playerExtras.clipSeekStep） */
let clipLoadStarted = false
/** 片段是否已经有可显示的帧：seek 完成（seeked / loadeddata）前不显示，避免露出黑帧/首帧 */
const clipFrameReady = ref(false)

const hasSprite = computed(() => !!(props.video && props.video.hasSprite))
const hasPreview = computed(() => !!(props.video && props.video.hasPreview))

/* hover 门槛只看断点，不看 (hover:hover)/(pointer:fine)：
   旧实现是一次性 matchMedia('(hover: hover) and (pointer: fine)')，在触屏笔记本 / 远程桌面 /
   主指针被识别成 coarse 的桌面浏览器上恒为 false —— 卡片因此永远不出现（修复的根因之一）。
   现在桌面宽度一律允许；≤768px 断点整块隐藏浮层（触屏没有 hover，拖动也不再显示，样式再兜一层）。 */
const mobileMq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 768px)')
    : null
const isMobile = ref(mobileMq ? mobileMq.matches : false)
const canHover = computed(() => !isMobile.value)

function onMobileMqChange(e) {
  isMobile.value = e ? !!e.matches : false
}

/* ============================================ P5.23 右侧常驻信息栏 ============================================ */

/** 断点必须与样式里的 @media 完全一致：>=1200px 是「视频 + 常驻列」，以下改成浮层 */
const narrowMq =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 1199px)')
    : null
const isNarrow = ref(narrowMq ? narrowMq.matches : false)

/** 折叠状态存储键：只记「用户希望这一列展开吗」，跨会话沿用（隐私模式写失败不影响行为） */
const SIDE_LS_KEY = 'qt-player-side-open'

function readSidePref() {
  try {
    const ls = typeof window !== 'undefined' ? window.localStorage : null
    // 缺省 = 展开：用户要求「信息抽屉默认展开」，只有明确存过 '0' 才收起来
    return !(ls && ls.getItem(SIDE_LS_KEY) === '0')
  } catch {
    return true
  }
}

function writeSidePref(open) {
  try {
    const ls = typeof window !== 'undefined' ? window.localStorage : null
    if (ls) ls.setItem(SIDE_LS_KEY, open ? '1' : '0')
  } catch {
    /* 隐私模式 / 配额满：只丢记忆，不影响本次会话 */
  }
}

/** 桌面展开态（落 localStorage）。窄屏浮层不写回这里 —— 否则一次窗口缩放就把「展开」记成「收起」 */
const sideOpenDesktop = ref(readSidePref())
/** 窄屏浮层默认收起：一进播放页就用浮层盖住画面不是「常驻信息栏」的本意 */
const sideOpen = ref(isNarrow.value ? false : sideOpenDesktop.value)

function applyNarrow(next) {
  isNarrow.value = !!next
  sideOpen.value = isNarrow.value ? false : sideOpenDesktop.value
}

function onNarrowMqChange(e) {
  applyNarrow(e ? !!e.matches : false)
}

/** 唯一的写入入口：窄屏只改本次会话的浮层开关，桌面同时落盘 */
function setSideOpen(v) {
  sideOpen.value = !!v
  if (isNarrow.value) return
  sideOpenDesktop.value = !!v
  writeSidePref(!!v)
}

function openSide() {
  setSideOpen(true)
}

function closeSide() {
  setSideOpen(false)
}

function toggleSide() {
  setSideOpen(!sideOpen.value)
}

/* P5.24：开关按钮的悬停态 —— 指针在信息栏（.p-side）或按钮上时任一为真 */
const sideAreaHover = ref(false)
const sideBtnHover = ref(false)
const sideHover = computed(() => sideAreaHover.value || sideBtnHover.value)

function onSideToggleHover(v) {
  sideBtnHover.value = !!v
}

/**
 * 唯一的信息栏开关（头部「信息」按钮与面板头部「› 收起」都并到这里）：
 *   - 收起态点击 → 展开，并 emit('open-meta') 让页面刷新「在当前时间加标记」的起手位置；
 *   - 展开态点击 → 收起，同时清掉悬停态（栏已归零，不能留着浮起的按钮）。
 */
function onSideToggle() {
  const willOpen = !sideOpen.value
  setSideOpen(willOpen)
  if (willOpen) emit('open-meta')
  else sideAreaHover.value = false
}

const spriteSrc = computed(() => (hasSprite.value ? api.spriteUrl(props.video.id) : ''))
const previewSrc = computed(() => (hasPreview.value ? api.previewUrl(props.video.id) : ''))

/* P5.2：三处徽标都由 seekPreview 一处换算（纯函数，playerExtras 单测覆盖），
   浮层大字 = 影片内容时间（ratio × 内容时长），不是 8 秒片段时长。
   P5.19：大字改成带帧号的 hh:mm:ss:ff —— 格式化交给 PreviewTimeBar（frameTimecode），
   与进度条右侧同一个纯函数，缺帧率时两边一起退化成 mm:ss。 */
const previewInfo = computed(() => seekPreview(previewRatio.value, seekDur.value || 0, clipDur))
const previewCaptionText = computed(() =>
  previewMode.value === 'clip' ? clipCaption(clipTime.value, previewInfo.value.clipDur) : ''
)
/** 是否真的显示浮层：悬停时若正好命中标记（要出标记提示条）就让位，避免两条浮层抢同一位置抖动 */
const previewShown = computed(() => previewOn.value && !markerHover.value)
/** 浮层只有悬停一种来源：is-hover 恒亮（≤768px 的样式靠它整块隐藏），is-clip / is-sprite 标注内容类型 */
const previewClass = computed(() => [previewMode.value === 'clip' ? 'is-clip' : 'is-sprite', 'is-hover'])
/** 是否具备浮层资源（有 pv2 或有精灵图）：两者都无时整块浮层不进 DOM，也不发任何请求 */
const previewAvailable = computed(() => !!(hasPreview.value || hasSprite.value))
/** 1px 指示线只在「指针在条上且能 hover」时出现（拖动中不出现：拖动不出浮层，划线只会干扰） */
const hoverLineVisible = computed(() => previewShown.value && canHover.value)

/* P4.4 进度条几何：thumb 直径由 playerExtras 的唯一常量决定（桌面 14px / 窄屏 10px），
   以 CSS 变量落到 .p-seek-col 上 —— 进度条、标记轨、刻度层、浮层锚点读的是同一组数字。
   原生 range 的可视轨道 = 元素宽 - thumb 宽（两端各留半个 thumb），所以「比例 → 像素」必须带上这个内缩，
   否则标记轨按容器全宽铺开，两端各偏半个 thumb（用户看到的「进度条和刻度没有对齐」）。 */
const thumbPx = computed(() => seekThumbPx(isMobile.value))

const seekVars = computed(() => ({
  '--seek-thumb': thumbPx.value + 'px',
  '--thumb-r': thumbPx.value / 2 + 'px'
}))

/**
 * P5.19 进度条右侧时间码：**一直**显示帧号（P5.16 只在拖动中显示，用户要求改成常显）。
 *   有 fps → 「位置 hh:mm:ss:ff / 总时长 hh:mm:ss:ff」，静止 / 暂停 / 播放 / 拖动完全同一条；
 *   无 fps → 「位置 mm:ss / mm:ss」（不知道帧率就不编假帧号，见 playerExtras.frameTimecode）。
 * 文案只有一个来源（playerExtras.seekTimecodeText），单测直接覆盖这条字符串。
 * 刷新频率（P5.22）：文案读的是 **seekTextPos**，不是 seekPos —— 滑块位置每帧都变（见 P5.22
 * 逐帧进度），**文本**则按 25Hz 节流（playerExtras.createSeekTextThrottle）：帧号 25 次/秒已看不出
 * 跳变，文本重排却少一半以上；拖动 / 暂停 / 松手落点一律 flush，立即精确。
 */
const seekNowText = computed(() => seekTimecodeText(seekTextPos.value, seekDur.value, frameFps.value))

/** 时间码的 title：有帧率写清四位含义，缺帧率如实说明「该片缺帧率数据」 */
const seekNowTitle = computed(() => seekTimecodeTitle(frameFps.value))

/** 进度条 title：无 fps 时不能承诺「精细」，如实说明按整秒拖动 */
const seekTitle = computed(() =>
  hasFps.value ? 'Shift+拖动 = 精细（落到帧）' : '播放位置（该片缺帧率数据，按整秒拖动、不显示帧号）'
)

/** 无障碍文本：知道帧率时补上时间码与帧号（读屏用户也能听到落在哪一帧），两侧都带帧号 */
const seekAriaText = computed(() => {
  const fps = frameFps.value
  // P5.22：跟文本节流（25Hz）走 —— 读屏软件不可能念 60 次/秒，每帧重建这段字符串纯属白花时间；
  // 与滑块真实位置的差最多 40ms，远小于一次朗读。
  if (!fps) return durText(seekTextPos.value) + ' / ' + durText(seekDur.value)
  const n = frameOf(seekTextPos.value, fps)
  return (
    timecode(seekTextPos.value, fps) +
    '（第 ' + (n == null ? 0 : n) + ' 帧） / ' +
    timecode(seekDur.value || 0, fps)
  )
})

/** 进度条已播放部分（CSS 渐变的断点）：原生 appearance 关掉后自己画填充，亮暗都跟 --accent */
const seekFillStyle = computed(() => {
  const dur = seekDur.value || 0
  const pos = seekPos.value || 0
  const pct = dur > 0 ? Math.min(100, Math.max(0, (pos / dur) * 100)) : 0
  return { '--p': pct.toFixed(3) + '%' }
})

/* ----------------------------- P5.22 播放中逐帧进度（rAF） ----------------------------- */

/**
 * 为什么需要这块：seekPos 原来只由 onTimeUpdate 写（浏览器 timeupdate ≈4–5 次/秒），
 * 60fps 的片一次就跳 12–15 帧、30fps 跳 6–7 帧 —— 用户看到的就是「十帧到十五帧跳一下」。
 * 现在播放中由 requestAnimationFrame 逐帧读 <video>.currentTime 写 seekPos，落点仍走 seekPosOf
 * （= 帧栅格），于是滑块**一帧一动**：60fps 片 60 次/秒、30fps 片 30 次/秒，与画面帧率严格对齐
 * （比「补间到 60Hz」更正确：滑块永远停在正显示的那一帧上，不会领先/落后画面）。
 *
 * 三条铁律：
 *   1. 只有 playing 才跑：暂停 / 结束 / 拖动中 / 页面隐藏由 progressGate 全挡掉，一帧都不空转；
 *   2. 位置每帧写，**时间码文本 25Hz** 写（seekTextPos + createSeekTextThrottle），
 *      拖动 / 暂停 / 松手落点一律 flush 立即精确；
 *   3. 闸门读的是 video 元素与普通变量，**不是**响应式状态 —— 每帧只写 seekPos 与（节流后的）
 *      seekTextPos 两个 ref，不会因为「读状态」把整棵组件多订阅一遍。
 */
const seekTextPos = ref(0)
const seekTextClock = createSeekTextThrottle()

/** 统一时钟：rAF 的 ts 与 performance.now() 同源（毫秒，自 time origin），节流窗口两边都用它 */
function perfNow() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

/** 闸门输入（每次现算）：直接问 <video>，与 isPlaying 镜像可能滞后半拍无关 */
function progressState() {
  const el = videoEl.value
  if (!el) return { paused: true }
  return {
    paused: !!el.paused,
    ended: !!el.ended,
    hidden: typeof document !== 'undefined' && !!document.hidden,
    dragging: qSeekDragging
  }
}

const seekClock = createProgressClock({
  gate: () => progressGate(progressState()),
  onTick: onProgressTick
})

/** 一帧一次：读 currentTime → 写滑块（值没变就不写，暂停贴边 / 静止的帧不会白触发渲染） */
function onProgressTick() {
  const el = videoEl.value
  // 播放中仍可能读到 ended / 被拖动打断：就地停掉，不留下一帧空转
  if (!el || el.paused || el.ended || qSeekDragging) {
    seekClock.stop()
    return
  }
  const pos = seekPosOf(absPos())
  if (isFinite(pos) && pos >= 0 && pos !== seekPos.value) seekPos.value = pos
}

/** 文本对齐到「此刻」的精确位置（暂停 / 结束 / 松手 / 切回前台用） */
function syncSeekText() {
  seekTextClock.flush(seekPos.value, perfNow())
  seekTextPos.value = seekPos.value
}

/**
 * 时间码文本的唯一读出口：滑块每帧都在变，文本只按 25Hz 落地。
 * 拖动中 / 时钟没在跑（暂停、逐帧步进、键盘跳转）→ 无条件 flush（必须立即精确）。
 */
watch(seekPos, (v) => {
  if (qSeekDragging || !seekClock.isRunning()) {
    seekTextClock.flush(v, perfNow())
    seekTextPos.value = v
    return
  }
  if (seekTextClock.push(v, perfNow())) seekTextPos.value = v
})

/** 播种：暂停态起播前先让文本有个准确起点（openVideo / 换片后 seekPos 会被写几次） */
syncSeekText()

/** 位置与文本都对齐到 <video> 的真实 currentTime（暂停 / 结束的那一刻必须精确到帧） */
function settleProgressExact() {
  updateSeekUi()
  syncSeekText()
}

/** 松手落地后：文本立刻精确；还在播就把逐帧进度接回去（暂停态保持停着，不空转） */
function resumeProgressAfterCommit() {
  syncSeekText()
  const el = videoEl.value
  if (el && !el.paused && !el.ended && !qSeekDragging) seekClock.start()
}

/** 页面隐藏 / 回到前台：隐藏时停（rAF 本来也会被挂起，显式停掉更稳），回来先重新对齐再续跑 */
function onDocVisibilityChange() {
  if (typeof document === 'undefined') return
  if (document.hidden) {
    seekClock.stop()
    return
  }
  settleProgressExact()
  seekClock.start()
}

/** 浮层水平位置：跟进度条比例走（与滑块中心同源，见 seekRatioCss），两侧留半宽避免出界（卡片宽 160，半宽 80） */
function floatStyle(ratio) {
  return { left: 'clamp(80px, ' + seekRatioCss(ratio) + ', calc(100% - 80px))' }
}

/** 指针位置 → 0~1 比例：先取 range 自身 rect（mousemove 挂在高 20px 的 .p-seekwrap 上，
    否则只有 4px 轨道能命中，指针稍偏就收不到事件），再按轨道几何（两端各半个 thumb）反解，
    hover 预览与标记命中的比例因此和滑块真实位置一致 */
function ratioFromEvent(e) {
  const el = seekEl.value || (e && e.currentTarget)
  if (!el || typeof el.getBoundingClientRect !== 'function') return 0
  const rect = el.getBoundingClientRect()
  if (!rect || !rect.width) return 0
  return seekPxToRatio(e.clientX - rect.left, rect.width, thumbPx.value)
}

/** 比例 → 精灵图格号 → col/row，再用 background-position 百分比切格（不依赖固定像素） */
const spriteStyle = computed(() => {
  const ratio = Math.min(1, Math.max(0, previewRatio.value))
  const cell = Math.min(SPRITE_CELLS - 1, Math.floor(ratio * SPRITE_CELLS))
  const col = cell % SPRITE_COLS
  const row = Math.floor(cell / SPRITE_COLS)
  return {
    backgroundImage: 'url("' + spriteSrc.value + '")',
    backgroundSize: SPRITE_COLS * 100 + '% ' + SPRITE_ROWS * 100 + '%',
    backgroundPosition:
      (col / (SPRITE_COLS - 1)) * 100 + '% ' + (row / (SPRITE_ROWS - 1)) * 100 + '%'
  }
})

/** 1px 指示线位置：与浮层同源比例（同一套轨道几何），提示「这条轨道可以 hover 出预览」 */
const hoverLineStyle = computed(() => ({
  left: seekRatioCss(previewRatio.value)
}))

/* P5.2：悬停节流。mousemove 几乎一帧一次，直接 seek 预览片段会疯狂抖动；
   80ms + 覆盖式尾部补发（createThrottle 在 playerExtras，可脱离浏览器单测）。
   P5.14 起拖动完全不碰浮层，所以拖拽不需要节流，也不必为它留后门。 */
const hoverPreview = createThrottle({ intervalMs: HOVER_PREVIEW_MIN_MS })

/* ------------------------------------------------- P5.15 hover 精确帧（按需实时取帧） */
/* 为什么不是更密的精灵图：hover 要精确到 1 秒，2 小时片 = 7200 格，单图放不下；多图方案
   磁盘 1-2GB、生成 10 小时。所以改成「精灵图零延迟兜底 + 250ms 后取真帧 + 按整秒永久缓存」。
   请求侧五道闸全在 framePicker.js（debounce / 同秒去重 / LRU / in-flight / 失败记忆），
   这里是纯胶水：拿到就盖上，失败就什么都不做。 */
const frameExact = ref(false)
const frameUrl = ref('')
/** 当前「想要的」帧键（id:整秒）：迟到的响应按它过滤，避免鼠标已经移开还盖上旧帧 */
const wantedFrameKey = ref('')

/**
 * 取帧预加载（P5.18）
 *
 * `decode()` 是修「预览框白屏」的关键：onload 只代表**字节**到齐，解码仍是异步的。
 * 直接把 URL 交给 background-image / <img src> 时，解码完成之前那一层是空的 —— 露出的是容器底色
 * （亮色主题下 --bg-3 ≈ 白 → 用户看到的白屏）。所以这里等 decode() 落地再回调，
 * 调用方拿到 done(true) 时这张图一定已经可以立刻画出来。
 *
 * 失败（400/404/503）一律 done(false)，由 framePicker 记进失败记忆并静默回退精灵图。
 */
function preloadImage(url, key, done) {
  if (typeof Image !== 'function') {
    done(false)
    return
  }
  const img = new Image()
  img.onload = () => {
    const d = typeof img.decode === 'function' ? img.decode() : null
    if (d && typeof d.then === 'function') d.then(() => done(true), () => done(true))
    else done(true)
  }
  img.onerror = () => done(false)
  img.src = url
}

const framePicker = createFramePicker({
  urlOf: (id, sec) => api.frameUrl(id, sec),
  load: preloadImage,
  onFrame: ({ key, url }) => {
    if (key !== wantedFrameKey.value) return // 鼠标已经移到别的秒了，迟到的帧丢弃
    frameUrl.value = url
    frameExact.value = true
  },
  // 失败静默回退：精灵图切片已经在下面了，这里什么都不做（不弹错、不重试同一个键）
  onFallback: ({ key }) => {
    if (key !== wantedFrameKey.value) return
    frameExact.value = false
  }
})

/** 精确帧的图像层样式（480 宽 jpeg，160×90 的卡片里 cover 填满） */
const frameImgStyle = computed(() => ({
  backgroundImage: 'url("' + frameUrl.value + '")'
}))

/**
 * 悬停到 ratio 处安排一次取帧
 * 门槛与浮层完全一致（移动端 / 无派生资源 / 拖动中都不发请求，判据唯一实现在 canRequestFrame）
 */
function scheduleFrame(ratio) {
  const id = props.video && props.video.id
  const info = seekPreview(ratio, seekDur.value || 0, clipDur)
  if (!id || info.labelSec == null) {
    frameExact.value = false
    return
  }
  const sec = frameSecond(info.labelSec, seekDur.value || 0)
  wantedFrameKey.value = id + ':' + sec
  const res = framePicker.schedule(id, sec, {
    // P5.14 口径：原画档拖动中不出浮层，自然也不取帧；
    // P5.17：转码档拖动中浮层是唯一能跟随进度的画面，必须允许取帧（仍有 debounce / 同秒去重 / LRU 五道闸）
    dragging: qSeekDragging && !isTranscode.value,
    mobile: isMobile.value,
    available: previewAvailable.value
  })
  // 没命中缓存就先退回兜底内容（精灵图切片 / 预览片段），等帧到了再盖上
  if (res.showed !== 'cache') frameExact.value = false
}

/* 换片：清空精确帧缓存与失败记忆（上一部片的图留着只是占内存，键里虽然带 id 也不会串味） */
watch(
  () => props.video && props.video.id,
  () => {
    framePicker.reset()
    wantedFrameKey.value = ''
    frameUrl.value = ''
    frameExact.value = false
    // P5.18：跟随层同理 —— 上一部片的跟随帧不能留在舞台上
    clearScrub()
    scrubPicker.reset()
  }
)

/** 这一部片能用哪种浮层：有 pv2 用预览片段，没有就降级精灵图切片，都没有就不显示 */
function previewModeFor() {
  if (hasPreview.value) return 'clip'
  if (hasSprite.value) return 'sprite'
  return ''
}

/** 按拖动比例把预览片段定位到对应帧（元数据未到时先 load，loadedmetadata 再补定位） */
function seekClip(ratio) {
  const info = seekPreview(ratio, 0, clipDur)
  clipTime.value = info.clipSeek
  const el = clipEl.value
  if (!el) return
  const step = clipSeekStep({ readyState: el.readyState, loadStarted: clipLoadStarted })
  if (step === 'load') {
    // preload="none"：只有真的要看预览时才发这一次请求（每部片至多一次）
    clipLoadStarted = true
    clipFrameReady.value = false
    try {
      el.load()
    } catch {
      /* 忽略：个别浏览器对未挂载的 src 直接抛 */
    }
    return
  }
  if (step === 'wait') return // 正在取片：不能重复 load()，否则每次都掐断上一次
  // 元数据到手但还没解出画面：先不显示（否则露出黑帧），等 loadeddata / seeked
  if (el.readyState < 2) clipFrameReady.value = false
  try {
    el.currentTime = info.clipSeek
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
}

/**
 * 显示（或更新）浮层：只有悬停会调到它（P5.14 起拖动不出浮层），所以永远只有一个浮层。
 * 移动端没有 hover，浮层在 ≤768px 一律不显示（样式再兜一层 display:none）。
 */
function showPreview(ratio) {
  const mode = previewModeFor()
  if (!mode) {
    hidePreview()
    return
  }
  const r = Math.min(1, Math.max(0, Number(ratio) || 0))
  previewMode.value = mode
  previewRatio.value = r
  previewOn.value = true
  if (mode === 'clip') seekClip(r)
  scheduleFrame(r)
}

function hidePreview() {
  previewOn.value = false
  // 浮层收起 = 这次 hover 结束了：撤掉待发取帧（已发出去的请求落回来也按 wantedFrameKey 丢弃）
  framePicker.leave()
  frameExact.value = false
}

/** 悬停进度条（不按下）：显示预览；节流到 80ms 一次，避免疯狂 seek */
function onSeekHover(e) {
  // P5.16「Shift+拖动 = 精细」提示：只要指针在进度条区域就出，与有没有预览资源无关
  seekTipOn.value = true
  if (!canHover.value || !previewAvailable.value) return
  if (qSeekDragging) return // 拖动中由 onSeekInput 收掉浮层，别互相抢
  const ratio = ratioFromEvent(e)
  hoverPreview.run(() => showPreview(ratio))
}

function onSeekLeave() {
  seekTipOn.value = false
  hoverPreview.cancel()
  if (qSeekDragging) return // 拖动中指针可能拖出条外：由 onSeekInput / onSeekCommit 管
  hidePreview()
}

function onClipMetadata() {
  const el = clipEl.value
  const d = el && el.duration
  if (isFinite(d) && d > 0) clipDur = d
  seekClip(previewRatio.value)
}

/** 片段已经解出画面（loadeddata / seeked）：这时候显示出来的才是「真的那一帧」 */
function onClipFrameReady() {
  clipFrameReady.value = true
}

const subSrc = computed(() => (props.video && props.video.sub ? api.subUrl(props.video.sub) : ''))
/* P5.24-A：tagList / actorList / qLabel 随底部标签条与画质文案一起删除 ——
   分类 / 演员数据本身仍在 props.video 上（右栏 VideoMetaPanel 与列表筛选照旧消费），
   画质文案由 PlayerSettings 的 qualityOptions 一处生成。 */

/**
 * app.js:230-234 fmtDur —— 实现搬到 playerExtras.durText（P5.19：进度条右侧退化文案与它必须同一口径，
 * 而纯函数才可单测）。行为一字未改：0 / 未知 / 负数 → --:--。
 */
function fmtDur(sec) {
  return durText(sec)
}

/** app.js:236-241 fmtSize */
function fmtSize(bytes) {
  const MB = 1048576
  const GB = 1073741824
  if (bytes == null || !isFinite(bytes)) return '—'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= MB) return (bytes / MB).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

/** app.js:221-228 resBadge */
function resBadge(w) {
  if (!w) return ''
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080p'
  if (w >= 1280) return '720p'
  return w + 'w'
}

watch(
  () => props.quality,
  (q) => {
    curQ.value = Q_VALUES.indexOf(q) >= 0 ? q : 'orig'
  }
)

/* ---------------------------------------------------------------- 位置换算 */

/** 绝对内容位置 = 流起点 + 片内偏移 */
function absPos() {
  const el = videoEl.value
  const t = (el && el.currentTime) || 0
  return (isTranscode.value ? streamStart : 0) + t
}

/** 内容总时长：原画取 video.duration；转码流取索引里的 dur（流时长是剩余段长度） */
function contentDur(v) {
  const el = videoEl.value
  const d = el ? el.duration : NaN
  if (!isTranscode.value && isFinite(d) && d > 0) return d
  const src = v || props.video || {}
  if (isFinite(src.dur) && src.dur > 0) return src.dur
  return isFinite(d) && d > 0 ? d : 0
}

/**
 * 源地址：原画走 /file?p=，转码走 /stream?p=&q=&t=（与 app.js:1035-1039 同一契约）
 *
 * P5.17：**不再对 startSec 取整**。转码流是服务端边转边推的分片 MP4，实测
 * `video.seekable` 只有 `[0, 0]`（浏览器把 currentTime 赋值夹回 0），所以「流内补 seek」
 * 这条路根本走不通 —— 唯一能把落点做到帧级的办法就是让服务端从**目标秒**出流。
 * 之前这里是 Math.floor，后端 parseStart 又 floor 一次，3.4s 于是变成 3.000s（整秒）。
 */
function srcFor(v, startSec) {
  if (curQ.value === 'orig') return api.mediaFileUrl(v.rel)
  return api.streamUrl(v.rel, { q: curQ.value, startSec })
}

/* ---------------------------------------------------------------- 转码提示 */

function endQHint() {
  if (qHintTimer) {
    clearTimeout(qHintTimer)
    qHintTimer = 0
  }
  qHintVisible.value = false
}

/** 首字节超过 3 秒才提示「转码中…」，避免一闪而过（app.js:1080-1084） */
function beginQHint() {
  endQHint()
  if (!isTranscode.value) return
  qHintTimer = setTimeout(() => {
    qHintVisible.value = true
  }, 3000)
}

/* ---------------------------------------------------------------- 进度条 */

/**
 * 内容时间 → 进度条 value（P5.16）：知道帧率时保留帧栅格上的小数，
 * 否则沿用原来的整秒（seekMax 也是整秒，两者口径必须一致，否则滑块会自己跳一下）。
 */
function seekPosOf(sec) {
  const t = Number(sec) || 0
  return hasFps.value ? snapToFrame(t, frameFps.value) : Math.round(t)
}

function updateSeekUi() {
  const dur = contentDur() || 0
  // P5.17：上限改由 seekPosOf 的同一套口径算 —— 知道帧率时取「不超出时长的最后一帧」
  // （10.2669s @30fps → 10.2666，原来 Math.round 给出 10，末尾 0.27 秒拖不到；
  //  上限与 value 不在同一张栅格上时滑块还会自己抖一下）。无 fps 时仍是整秒，行为不变。
  if (dur > 0) {
    const cap = seekPosOf(dur)
    seekMax.value = Math.max(1, cap > 0 ? cap : Math.round(dur))
  }
  seekDur.value = dur
  if (qSeekDragging) return
  const pos = absPos()
  if (isFinite(pos) && pos >= 0) seekPos.value = seekPosOf(pos)
}

/** 原画模式 seek：直写 currentTime，浏览器按 Range 取新位置（不重开流、不动 streamStart） */
function seekOrigTo(sec) {
  const el = videoEl.value
  if (!el) return
  const d = isFinite(el.duration) && el.duration > 0 ? el.duration : 0
  const cap = d || (seekMax.value > 0 ? seekMax.value : 0)
  let t = Number(sec) || 0
  if (cap > 0) t = Math.min(t, cap)
  t = Math.max(0, t)
  try {
    el.currentTime = t
    lastSeekWrite = t
    lastSeekWriteAt = Date.now()
  } catch {
    /* 忽略：未就绪的流拒绝赋值 */
  }
  seekPos.value = seekPosOf(t)
}

/* ---------------------------------------------------------------- 换源 */

/**
 * absStart = 转码流的内容起点（= 请求后端 {@code t} 的那个秒值），seekAbs = 加载后要落到的内容位置（0 = 不跳）
 *
 * P5.17：streamStart 保留小数。它必须与真正发给后端的 {@code t} **逐位一致** ——
 * 转码流在浏览器里不可 seek（seekable=[0,0]），前端没法靠「流内补一次 currentTime」纠偏，
 * 所以内容位置 = streamStart + currentTime 只有在 streamStart 精确时才是对的。
 */
function applySource(v, absStart, seekAbs) {
  streamStart = isTranscode.value ? Math.max(0, Number(absStart) || 0) : 0
  pendingSeek = seekAbs > 0.5 ? seekAbs : 0
  lastQSrcAt = Date.now()
  const el = videoEl.value
  if (!el) return
  // P5.20：任何一次换源都作废上一次「挂起中」的换流 —— 否则迟到的 switchSrc 会把新 src 覆盖回旧的
  const token = ++switchToken
  const src = srcFor(v, streamStart)
  if (!isTranscode.value) {
    // 原画直连流没有「服务端起动延时」，换源即出帧 —— 不盖任何东西（P5.17 契约：原画拖动不出浮层）
    clearStreamCover()
    switchPending = false
    el.src = src
    el.load()
    if (wantPlay) {
      wantPlay = false
      tryPlay()
    }
  } else {
    // 转码流首帧要等服务端 ffmpeg 出流（实测数百毫秒到数秒）：先冻结当前画面，再换 src
    switchWithFrozenCover(el, src, v, token)
  }
  // P4.1：换源（切清晰度 / 转码重开流 / 换片）会把 playbackRate 打回 1 —— 这里重新落一次倍速，
  // 保证「切清晰度后仍保持当前倍速」（defaultPlaybackRate 一并写，避免下次 load 又丢）
  applySpeed()
  beginQHint()
  updateSeekUi()
}

/* --------------------------- P5.20 换流覆盖层：canvas 冻结当前画面 */

/**
 * 换流后到首帧之间盖在 <video> 上的那一层（只在转码档出现）
 *
 * <p><b>为什么不再直接用取帧接口的图</b>（P5.17/P5.18 的做法，用户反馈「黑屏 → 低清 → 播放」）：</p>
 * <ol>
 *   <li><b>黑屏</b>：那张图要现取现解码（后端 ffmpeg 现解一帧 100-400ms + 前端 decode），
 *       而 <video> 的 emptied 已经把画面清掉了 —— 这段时间舞台上是空的。覆盖层元素先出现、
 *       图后到，中间就是一个纯黑窗口；</li>
 *   <li><b>低清</b>：那张图只有 480 宽（MediaFrameCommand.FRAME_WIDTH），铺满舞台就是放大。</li>
 * </ol>
 *
 * <p><b>现在的做法</b>：换流前把**当前正在显示的像素**用 canvas 画下来当覆盖层 ——
 * 0 请求、尺寸等于舞台显示尺寸、0 放大，所以「点击 → 有画面」之间没有任何一帧是空的。
 * 取帧接口保留但只做两件事：① 把画面**升级**成目标位置的高分辨率帧（宽 ≥960，仍是每换流 1 个请求）；
 * ② canvas 不可用（tainted / 无可绘制帧）时兜底。新流 canplay 后 180ms 淡出。</p>
 *
 * 时序由 coverFreeze.coveredSwitch 统一保证：freeze → show（上屏）→ arm（取帧/兜底计时）→
 * 等 paint（decode + 一帧 rAF）→ 才写 src。
 */
const coverOn = ref(false)
const coverSrc = ref('')
/** 这层内容来自哪儿：freeze = canvas 冻结的当前像素；frame = 取帧接口的图（升级 / B 兜底） */
const coverOrigin = ref('')
/** 取帧兜底请求的宽度（960~1280，按舞台 CSS 宽度取，见 coverFreeze.coverFrameWidth） */
const coverFrameW = ref(coverFrameWidth(0))
const coverFading = ref(false)
const coverEl = ref(null)
const scrubCoverEl = ref(null)
let coverTimer = 0
let coverFadeTimer = 0
/** 冻结图的 dataURL：取帧图加载失败时退回它（好过露出黑底） */
let coverFrozenSrc = ''
/** 换流序号：迟到的 paint / 取帧回调靠它判断「自己是不是已经被更新的换流取代」 */
let switchToken = 0
/** 转码换流的 src 还没写下去（这期间 play() 要排队，不能放到旧流上）*/
let switchPending = false
let wantPlay = false

/** 冻结当前画面：拖动跟随层铺着就用它（正是用户此刻看到的那张），否则用 <video> 的当前帧 */
function freezeCoverFrame() {
  const scrub = scrubCoverEl.value
  const from = scrubOn.value && scrub && scrub.complete && scrub.naturalWidth ? scrub : videoEl.value
  if (!from) return ''
  return freezeElementFrame(from)
}

/**
 * 转码换流：先冻结 → 冻结图上屏 → 再写 src
 *
 * <p>src 的写入被推到「冻结图已经画上屏」之后，这就是「中间没有任何一帧是空的」的**唯一**保证：
 * 覆盖层先有内容，<video> 才被 emptied；等到 canplay，新流的画已经在那儿了，覆盖层才淡出。</p>
 */
function switchWithFrozenCover(el, src, v, token) {
  switchPending = true
  coveredSwitch(
    {
      freeze: () => freezeCoverFrame(),
      show: (data) => {
        coverFrozenSrc = data
        coverSrc.value = data
        coverOrigin.value = 'freeze'
        coverFading.value = false
        coverOn.value = true
      },
      arm: (frozen) => showStreamCover(v, streamStart, frozen, token),
      paint: () => whenCoverPainted(),
      switchSrc: () => {
        if (token !== switchToken) return // 期间又发生了新的换流：这次作废
        el.src = src
        el.load()
        switchPending = false
        if (wantPlay) {
          wantPlay = false
          tryPlay()
        }
      }
    },
    { token: () => token, cancelled: () => token !== switchToken }
  )
}

/**
 * 等覆盖层「真的被画出来」
 *
 * <p>只等 nextTick 不够（dataURL 仍要解码一次），只等 decode 也不完全够（解码完成到合成器真的
 * 画上屏还差一帧）。所以 decode + 双 rAF，并带 120ms 上限：后台标签页里 rAF 不跑，
 * 不能让换流永远挂在那里。</p>
 */
function whenCoverPainted() {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(true)
    }
    const guard = setTimeout(finish, 120)
    nextTick().then(async () => {
      const img = coverEl.value
      try {
        if (img && typeof img.decode === 'function') await img.decode()
      } catch (e) {
        /* 忽略：decode 拒绝（图被撤 / 派生出错）也要继续换流，否则卡死在旧流上 */
      }
      const after = () => {
        clearTimeout(guard)
        finish()
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(after))
      else after()
    })
  })
}

/**
 * 冻结图就位之后：起兜底计时 + 发起**一次**高分辨率取帧
 *
 * <p>P5.18：**不再向下取整到整秒**。取整的那一帧是「这一秒的第一帧」，于是用户先看到整秒位置、
 * 再看到真正落点 —— 正是反馈里的「先跳到整秒位置再跳到点击位置」。这里继续用精确取帧
 * （帧接口的 t 支持小数，这一路不落盘缓存，见 useMediaApi.frameExactUrl）。</p>
 *
 * <p>P5.20 的两点变化：① 追加 <code>&amp;w=</code>（960~1280，按舞台 CSS 宽度）；
 * ② 先 preloadImage 解码、解码成功才换 src —— <code>&lt;img&gt;</code> 换 src 时旧画面会留到
 * 新图可绘制为止，所以这次「升级」也不会出现空窗。</p>
 */
function showStreamCover(v, sec, frozen, token) {
  if (!v || !v.id) return
  if (coverTimer) {
    clearTimeout(coverTimer)
    coverTimer = 0
  }
  // 兜底：后端 504 / 客户端断流时 canplay 永远不来，12s 后自己撤（后端首字节超时是 15s）
  coverTimer = setTimeout(() => {
    coverTimer = 0
    coverOn.value = false
    coverFading.value = false
  }, 12000)
  const w = coverFrameWidth(stageEl.value && stageEl.value.clientWidth)
  coverFrameW.value = w
  // 兜底宽度下限 960（coverFreeze.COVER_FRAME_MIN_WIDTH）：480 铺满舞台就是用户看到的「低清」
  const url = api.frameExactUrl(v.id, Math.max(0, Number(sec) || 0)) + '&w=' + w
  if (!frozen) {
    // B 兜底：canvas 不可用（tainted / 没有可绘制帧）→ 直接挂取帧 URL，回到 P5.18 的老行为
    coverFrozenSrc = ''
    coverSrc.value = url
    coverOrigin.value = 'frame'
    coverFading.value = false
    coverOn.value = true
  }
  preloadImage(url, v.id + ':cover:' + sec, (loaded) => {
    if (!loaded || token !== switchToken || !coverOn.value) return
    coverSrc.value = url
    coverOrigin.value = 'frame'
  })
}

/** 覆盖层图片加载失败：有冻结图就退回冻结图（好过露黑底），否则撤掉这层 */
function onCoverError() {
  if (coverFrozenSrc && coverSrc.value !== coverFrozenSrc) {
    coverSrc.value = coverFrozenSrc
    coverOrigin.value = 'freeze'
    return
  }
  coverOn.value = false
  coverFading.value = false
}

/** 收覆盖层（换原画流 / 换片 / 淡出结束） */
function clearStreamCover() {
  if (coverTimer) {
    clearTimeout(coverTimer)
    coverTimer = 0
  }
  if (coverFadeTimer) {
    clearTimeout(coverFadeTimer)
    coverFadeTimer = 0
  }
  coverOn.value = false
  coverFading.value = false
  coverFrozenSrc = ''
}

/**
 * canplay 之后淡出（180ms）再移除
 *
 * <p>为什么不是立刻 v-if 删掉：canplay 只保证「有可播放的帧」，合成器把那一帧画出来仍差一点；
 * 硬切会闪一下黑。这 180ms 正好盖住它。</p>
 */
function fadeStreamCover() {
  if (!coverOn.value || coverFading.value) return
  if (coverTimer) {
    clearTimeout(coverTimer)
    coverTimer = 0
  }
  coverFading.value = true
  if (coverFadeTimer) clearTimeout(coverFadeTimer)
  coverFadeTimer = setTimeout(() => {
    coverFadeTimer = 0
    clearStreamCover()
  }, 180)
}

/* ------------------------------- P5.18 转码档拖动：舞台级「画面跟随」 */

/**
 * 拖动中的跟随层（只用于转码档）
 *
 * 用户反馈：「非原画档拖动的时候视频画面不会跟随进度条变化（原画档可以，拖到哪里画面就是哪里）」。
 * 原画档能跟手是因为 currentTime 直接生效；转码流的 seekable 恒为 [0,0]（P5.17 实测），
 * currentTime 写不进去 —— 唯一能「跟着走」的画面就是取帧接口给的静止帧。
 * P5.17 只在进度条上方的小浮层里给了它（160×90），主画面仍是拖动前那一帧，
 * 所以这里把它同时铺到**整个舞台**（.p-scrub-cover），松手后交给 .p-stream-cover 接棒。
 *
 * 取帧走整秒缓存（frameSecond 同一口径）：同一秒只请求一次、命中零延迟，请求数与 hover 同级。
 * 精度由「拖动中的帧码 位置 hh:mm:ss:ff」与松手落点（精确起播秒）保证，与 P5.17 一致。
 */
const scrubOn = ref(false)
const scrubSrc = ref('')
const scrubWanted = ref('')

const scrubPicker = createFramePicker({
  urlOf: (id, sec) => api.frameUrl(id, sec),
  load: preloadImage,
  onFrame: ({ key, url }) => {
    if (key !== scrubWanted.value) return // 已经拖到别的位置了，迟到的帧丢弃
    scrubSrc.value = url
    scrubOn.value = true
  },
  // 取帧失败：静默撤掉（下面还是暂停住的那一帧，比顶着错图强）
  onFallback: ({ key }) => {
    if (key === scrubWanted.value) scrubOn.value = false
  }
})

/** 拖动到 target → 安排一次「跟随帧」（转码档专用；dragging 显式放行，否则 canRequestFrame 会拒） */
function scheduleScrub(target) {
  const id = props.video && props.video.id
  if (!id) return
  const sec = frameSecond(target, seekDur.value || 0)
  scrubWanted.value = id + ':' + sec
  scrubPicker.schedule(id, sec, { dragging: false, mobile: false, available: true })
}

/** 收起跟随层（松手 / 换源 / 换片） */
function clearScrub() {
  scrubPicker.leave()
  scrubWanted.value = ''
  scrubOn.value = false
  scrubSrc.value = ''
}

/** 首帧就绪（canplay）：覆盖层淡出。暂停态换流也会走到这里，所以不能只在 playing 里撤 */
function onCanPlay() {
  fadeStreamCover()
}

/** 自动播放可能被浏览器拦截（无用户手势 + 有声音）：不报错，露出「点击播放」兜底 */
function tryPlay() {
  const el = videoEl.value
  if (!el) return
  // P5.20：转码换流还在等冻结图上屏（src 尚未写下去）—— 这时 play() 打到的是**旧流**，
  // 会先响一下旧声音、播一小段旧画面。排队到 switchSrc 之后再放。
  if (switchPending) {
    wantPlay = true
    return
  }
  const p = el.play()
  if (p && p.catch) p.catch(() => { tapVisible.value = true })
}

/* ---------------------------------------------------------------- 埋点结算 */

/** 完播率：absPos 已处理转码 offset，contentDur 已处理时长口径（app.js:99-107） */
function playProgress() {
  const dur = contentDur()
  if (!(dur > 0)) return 0
  const pct = (absPos() / dur) * 100
  if (!isFinite(pct)) return 0
  return Math.min(100, Math.max(0, Math.round(pct)))
}

/** 结算本段观看：暂停 / 结束 / 切视频 / 关闭 / 离开都会走到 */
function settlePlay(id) {
  const vid = id == null ? (props.video ? props.video.id : '') : id
  if (!vid) return
  props.tracker.trackPlayEnd(vid, undefined, playProgress())
}

/* ---------------------------------------------------------------- 进度记忆 */

/** 距结尾 15 秒内视为看完（app.js:1180-1194） */
function savePosFor(v) {
  const el = videoEl.value
  if (!v || !el) return
  const dur = contentDur(v)
  const pos = absPos()
  if (!dur || !isFinite(dur)) return
  if (dur - pos <= 15) {
    emit('clear-pos', v.id)
    emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  } else if (pos > 1) {
    emit('save-pos', { id: v.id, pos, dur })
    emit('push-recent', { id: v.id, pos, dur })
  }
}

/** 播放中每 5 秒 / 暂停时上报服务端最近浏览（app.js:985-998，沿用原页 raw currentTime 口径） */
function pushRecentServerFor(v) {
  const el = videoEl.value
  if (!el || !v) return
  const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : v.dur || 0
  const pos = el.currentTime || 0
  if (!(pos > 0.5)) return
  lastRecentPush = Date.now()
  emit('push-recent', { id: v.id, pos, dur })
}

function pushRecentServer() {
  pushRecentServerFor(props.video)
}

/* ---------------------------------------------------------------- 打开 / 切换 */

function openVideo(v, resumePos) {
  const el = videoEl.value
  if (!el || !v) return
  openedVideo = v
  // P4-B：AB 点与帧取样都是「这一部」的状态，换片/重开必须清空（增益、倍速与帮助浮层是用户偏好，保留）
  abA.value = null
  abB.value = null
  laneLastKey = '' // 换片后「区间标记再点一下跳 endPos」的记忆要重来，否则可能撞上同名 key
  stopFrameSampling()
  props.tracker.openPlaySession(v.id) // 新的播放器会话：本会话只报一次 play
  // P5.17：续播落点同样吸到帧栅格 —— 存盘的是小数秒，但转码档要拿它当流起点，
  // 不吸帧就会出现「续播总是从某个不存在的帧开始」（且与松手落点口径不一致）
  const pos = snapToFrame(Math.max(0, Number(resumePos) || 0), frameFps.value)
  const total = v.dur || 0
  const canResume = pos > 1 && (!total || pos < total - 15)
  restartVisible.value = canResume
  warnVisible.value = v.browserOk === false
  qFallback = false
  el.pause()
  el.removeAttribute('src')
  applySource(v, canResume ? pos : 0, canResume ? pos : 0)
  lastPosWrite = Date.now()
  lastRecentPush = Date.now()
  tapVisible.value = false
  isPlaying.value = false
  onVolumeChange()
  // 换片 / 重开：浮层不能残留上一部的格子与预览帧（clipDur 也要重测）
  hidePreview()
  previewMode.value = ''
  clipDur = 0
  clipLoadStarted = false
  clipFrameReady.value = false
  tryPlay()
}

/** 打开 / 换片 / 同片重开都走这里：先结算上一段，再起新源 */
watch(
  () => (props.video ? props.video.id : '') + '#' + props.openSeq,
  () => {
    const prev = openedVideo
    if (prev && prev.id !== props.video.id) {
      savePosFor(prev)
      pushRecentServerFor(prev)
    }
    if (prev) settlePlay(prev.id)
    openVideo(props.video, props.startPos)
  }
)

/** 全屏状态镜像：只用于切换控制条上的「全屏 / 退出全屏」标签 */
function onFsChange() {
  const d = document
  fsActive.value = !!(d.fullscreenElement || d.webkitFullscreenElement)
}

/* iOS 视频元素全屏（webkitEnterFullscreen）不触发 document 的 fullscreenchange，
   靠元素自身的 webkitbegin/endfullscreen 同步按钮图标；桌面端这两个事件永不触发。 */
function onIosFsIn() {
  fsActive.value = true
}

function onIosFsOut() {
  fsActive.value = false
}

onMounted(() => {
  if (mobileMq && mobileMq.addEventListener) mobileMq.addEventListener('change', onMobileMqChange)
  // P5.23：断点切换只改布局与浮层开关，不落盘（见 setSideOpen）
  if (narrowMq && narrowMq.addEventListener) narrowMq.addEventListener('change', onNarrowMqChange)
  document.addEventListener('fullscreenchange', onFsChange)
  document.addEventListener('webkitfullscreenchange', onFsChange)
  // P4.3：标记列表浮层的「点外部收起」（capture，先于按钮 click）
  document.addEventListener('pointerdown', onDocPointerDown, true)
  // P4.4：页面级快捷键也算「有操作」，全屏下控制条据此重新计时
  document.addEventListener('keydown', onDocKeydown)
  // P5.22：页面隐藏时停 rAF、回前台重新对齐（见 onDocVisibilityChange）
  document.addEventListener('visibilitychange', onDocVisibilityChange)
  openVideo(props.video, props.startPos)
})

onBeforeUnmount(() => {
  if (mobileMq && mobileMq.removeEventListener) {
    mobileMq.removeEventListener('change', onMobileMqChange)
  }
  if (narrowMq && narrowMq.removeEventListener) {
    narrowMq.removeEventListener('change', onNarrowMqChange)
  }
  document.removeEventListener('fullscreenchange', onFsChange)
  document.removeEventListener('webkitfullscreenchange', onFsChange)
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  document.removeEventListener('keydown', onDocKeydown)
  document.removeEventListener('visibilitychange', onDocVisibilityChange)
  // P5.22：卸载必须撤掉 rAF，否则回调会写到已销毁组件的 ref 上
  seekClock.stop()
  // P4.4：清掉自动隐藏计时器（否则卸载后仍会回调一次 onChange）
  ctrlAuto.dispose()
  endQHint()
  // P4-B：释放请求的帧回调与 WebAudio 图（不释放会一直占着 AudioContext，Chrome 上限 6 个）
  stopFrameSampling()
  closeAudioGraph()
  // P5.15：撤掉取帧定时器并清空 LRU（不撤的话卸载后仍会补发一次请求、回调写到旧组件的 ref 上）
  framePicker.reset()
  // P5.18：跟随层同样要撤（否则卸载后仍会往旧组件的 ref 上写一次）
  clearScrub()
  scrubPicker.reset()
  clearStreamCover()
  const el = videoEl.value
  const v = openedVideo || props.video
  if (v) savePosFor(v)
  settlePlay(v ? v.id : '')
  if (el) {
    el.pause()
    el.removeAttribute('src')
    el.load()
  }
})

/* ---------------------------------------------------------------- 清晰度 */

/**
 * 画质 select 的唯一入口（P5.24-A：原来读事件对象，现在设置浮层直接 emit 档位值）。
 * 行为与 P4-B 完全一致：手动选档允许重试 → 取绝对位置 → 换流 → 恢复播放状态。
 */
function onQualityPick(nq) {
  if (Q_VALUES.indexOf(nq) < 0 || nq === curQ.value) return
  qFallback = false // 手动选档允许重试
  const abs = absPos() // 先按旧档取绝对位置
  const el = videoEl.value
  const wasPlaying = !!el && !el.paused && !el.ended
  curQ.value = nq
  emit('update:quality', nq)
  updateSeekUi()
  applySource(props.video, abs, abs)
  if (wasPlaying) tryPlay()
}

/* ---------------------------------------------------------------- 拖动 */

/**
 * 帧级 seek 的落点合并：拖动期间的 seek 只按动画帧落地（≤60 次/秒）。
 * 为什么必须合并：input 事件率随指针/系统而变（实测 120–1000Hz），逐个写 currentTime
 * 会让 4K 片每次都重解一个 GOP —— 画面卡顿、CPU 打满（P5.16 的性能约束）。
 */
const seekRaf = createRafSeek({ apply: (t) => seekOrigTo(t) })

/** 拖动期间是否因为转码档被本组件暂停过（松手后要按原状态恢复） */
let dragAutoPaused = false

/** P5.18：最近一次真正写进 <video>.currentTime 的落点（帧栅格上），用于「一次手势只写一次」 */
let lastSeekWrite = NaN
let lastSeekWriteAt = 0

/**
 * 转码档拖动开始：暂停播放
 *
 * 为什么必须暂停：转码流的 seekable 恒为 [0,0]（实测），拖动中 currentTime 写不进去，
 * 画面只能继续按**拖动前**的位置往前播 —— 用户看到的就是「视频还在原地播放」。
 * 暂停后画面冻结在拖动前那一帧，再由浮层负责「画面跟随」。
 */
function pauseForTranscodeDrag() {
  const el = videoEl.value
  if (!el || dragAutoPaused) return
  if (el.paused || el.ended) return
  dragAutoPaused = true
  el.pause()
}

function onSeekInput(e) {
  // P5.16：Shift 精细拖动是「接管」手势，原生 range 的 value 变化一律忽略
  if (fineDrag.active) return
  qSeekDragging = true
  syncCtrlState()
  // P5.22：拖动一开始就停 rAF —— 位置从此归本函数写，逐帧进度别跟着抢（松手后 resumeProgressAfterCommit 接回）
  seekClock.stop()
  // P5.16 帧级：value 是连续值（step = 1/fps），这里再吸一次帧栅格，
  // 保证 currentTime 恰好 = round(t*fps)/fps（浏览器对 step 的取整有浮点误差）。
  const target = snapToFrame(Number(e.target.value) || 0, frameFps.value)
  seekPos.value = target
  // 取消悬停的待发任务，避免松手后又按旧位置补发一次
  hoverPreview.cancel()
  if (isTranscode.value) {
    // P5.17：转码档拖动**要出浮层** —— 流在浏览器里不可 seek（seekable=[0,0]），
    // 画面本身永远跟不上进度条，浮层（精灵图/预览片段 + 250ms 后的精确帧）是唯一能
    // 「画面跟着进度条走」的东西。与 hover 共用 80ms 节流，请求数不会涨。
    pauseForTranscodeDrag()
    hoverPreview.run(() => showPreview(seekMax.value > 0 ? Number(target) / seekMax.value : 0))
    // P5.18：主画面也要跟随（浮层只有 160×90，用户看的是舞台）—— 见 scheduleScrub 注释
    scheduleScrub(target)
    return
  }
  // P5.14 原画档：拖动即写 currentTime，视频画面本身就跟手，浮层只重复一遍还挡进度 —— 收掉
  hidePreview()
  seekRaf.push(target)
}

function onSeekCommit(e) {
  commitSeekTo(snapToFrame(Number(e.target.value) || 0, frameFps.value))
}

/**
 * 松手落地（原生拖动 / Shift 精细拖动 / 键盘共用）。
 * 先 cancel 掉挂起的合并落点再同步写最终位置：否则最后一帧的挂起值会在 commit 之后
 * 才落地，覆盖掉这里的精确位置（表现为「松手后跳一下」）。
 * 这里用 cancel 而不是 flush：flush 会先写一次旧位置，等于一次多余的 4K seek。
 */
function commitSeekTo(target) {
  qSeekDragging = false
  syncCtrlState()
  hidePreview()
  const resume = dragAutoPaused // 拖动期间被 pauseForTranscodeDrag 暂停过
  dragAutoPaused = false
  // P5.14：松手即回到 hover 行为。指针通常还停在条上，下一次 mousemove 才会重新出图，
  // 这里按松手位置直接补一次悬停浮层（不经过 hover 的节流窗口），免得「松手后画面没了」像卡住。
  restoreHoverAt(target)
  if (!isTranscode.value) {
    // 原画：精确写 currentTime（实测 currentTime 就落在这个帧上，不取整）
    seekRaf.cancel()
    // P5.18：一次手势只写一次 —— input 的 rAF 落点若已经把同一帧写进去了，这里不再写第二次。
    // 两次赋值 = 两次 seek 往返（用户看到的「跳两下」），而且第二次毫无信息量。
    const justWrote =
      Date.now() - lastSeekWriteAt < 400 && !shouldSeekWrite(target, lastSeekWrite, frameFps.value)
    if (!justWrote) seekOrigTo(target)
    updateSeekUi()
    if (resume) tryPlay()
    // P5.22：松手 = 位置已是精确值 → 文本立即对齐；还在播就把逐帧进度接回去
    resumeProgressAfterCommit()
    return
  }
  // P5.17 转码：**必须**用同一个精确秒既当流起点又当内容位置。
  // streamStart = target（不取整）→ 服务端 -ss target → 流的第 0 秒就是目标那一帧；
  // seekAbs 传 0：转码流 seekable=[0,0]，再写一次 currentTime 只会被浏览器夹回 0。
  seekRaf.cancel()
  // P5.20：**先** applySource 再收跟随层 —— 冻结图要从跟随层（用户此刻看到的那张）上取像素；
  // 反过来先 clearScrub 的话，冻结图只能退回「拖动前那一帧」，松手瞬间画面会往回跳一下。
  applySource(props.video, target, 0)
  clearScrub() // 跟随帧的任务结束：像素已经拷进 .p-stream-cover
  tryPlay()
  // P5.22：转码档此刻还是暂停的（dragAutoPaused），start() 会被闸门挡住；
  // 真正续跑由随后的 play / playing 事件负责（同一处口径，不额外猜状态）
  resumeProgressAfterCommit()
}

/* ------------------------------------------------- P5.16 Shift 精细拖动 */

/**
 * 为什么原生 range 做不到「精细」：指针位置 → value 是浏览器内建的 1:1 映射
 * （整条轨道 = 整个时长），JS 改不了灵敏度。所以按住 Shift 时**接管**这个手势：
 * preventDefault 掉原生拖动，按相对位移 dt = fineDelta(dx, 轨道宽, 时长, 10) 算落点，
 * 于是同一段像素位移只前进 1/10 的时长（2 小时片 1px 从 216 帧降到 ≈22 帧）。
 * 移动端不启用（没有 Shift），知道帧率才启用（否则 step=1，落点本来就只能是整秒）。
 */
const fineDrag = { active: false, startX: 0, startTime: 0, trackW: 0, duration: 0 }
const fineDragging = ref(false)
/** 指针是否停在进度条区域（决定「Shift+拖动 = 精细」提示什么时候出现） */
const seekTipOn = ref(false)

/** 提示文案：画在进度条上方，不抢拖动与浮层（pointer-events:none） */
const seekTipText = computed(() => {
  if (isMobile.value || !hasFps.value) return ''
  if (fineDragging.value) return '精细拖动 ×1/10（Shift）'
  if (seekTipOn.value || qSeekDragging) return 'Shift+拖动 = 精细'
  return ''
})

function onSeekPointerDown(e) {
  if (!hasFps.value || isMobile.value) return
  if (!e || !e.shiftKey) return // 普通拖动仍走原生 range：手感、点击跳转、无障碍全部沿用浏览器
  if (!videoEl.value) return
  const el = seekEl.value
  const rect = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
  const geom = seekTrackGeom(rect ? rect.width : 0, thumbPx.value)
  const dur = contentDur() || seekMax.value || 0
  if (!(geom.trackW > 0) || !(dur > 0)) return
  e.preventDefault() // 掐掉原生拖动（否则 value 还会按 1:1 乱跳）
  fineDrag.active = true
  fineDrag.startX = e.clientX
  fineDrag.startTime = Math.max(0, Math.min(dur, absPos()))
  fineDrag.trackW = geom.trackW
  fineDrag.duration = dur
  fineDragging.value = true
  qSeekDragging = true
  syncCtrlState()
  // P5.22：Shift 精细拖动同样停 rAF（与 onSeekInput 同一条口径）
  seekClock.stop()
  hoverPreview.cancel()
  hidePreview()
  window.addEventListener('pointermove', onFineDragMove)
  window.addEventListener('pointerup', onFineDragEnd)
  window.addEventListener('pointercancel', onFineDragEnd)
}

function onFineDragMove(e) {
  if (!fineDrag.active) return
  const dt = fineDelta(e.clientX - fineDrag.startX, fineDrag.trackW, fineDrag.duration, FINE_DRAG_ZOOM)
  const target = snapToFrame(
    Math.max(0, Math.min(fineDrag.duration, fineDrag.startTime + dt)),
    frameFps.value
  )
  // 半帧容差：同一帧内的位移不再写一次 currentTime（4K 每次 seek 都要重解 GOP）
  if (sameFrame(target, seekPos.value, frameFps.value)) return
  seekPos.value = target
  if (!isTranscode.value) seekRaf.push(target)
}

function onFineDragEnd() {
  if (!fineDrag.active) return
  fineDrag.active = false
  fineDragging.value = false
  window.removeEventListener('pointermove', onFineDragMove)
  window.removeEventListener('pointerup', onFineDragEnd)
  window.removeEventListener('pointercancel', onFineDragEnd)
  commitSeekTo(seekPos.value)
}

/** 松手后恢复悬停浮层：移动端 / 无预览资源时什么都不做（与 hover 同一套门槛） */
function restoreHoverAt(pos) {
  if (!canHover.value || !previewAvailable.value) return
  hoverPreview.cancel()
  showPreview(seekMax.value > 0 ? Number(pos) / seekMax.value : 0)
}

/** 进度条键盘 ←/→：自己处理并阻断冒泡，避免与页面级快捷键重复跳一次 */
function onSeekKey(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  e.stopPropagation()
  const step = e.shiftKey ? 15 : 5
  // P5.16：键盘跳转同样落在帧栅格上（seekRel 内部已 snap），这里再按实际位置回读，
  // 保证「跳 5 秒」之后滑块与画面在同一帧上（不四舍五入到整秒）。
  seekRel(e.key === 'ArrowLeft' ? -step : step)
  if (!isTranscode.value) seekPos.value = seekPosOf(absPos())
}

/* ================================================================================
   P4-B：AB 循环 / 逐帧 / 音量增益 / 标记刻度 / 快捷键浮层
   全部按「内容时间」工作（absPos / contentDur 已处理转码流起点），因此与进度记忆、
   清晰度切换、埋点口径完全一致；下面除了 onTimeUpdate 里新增的一行回跳判定外，
   没有改动任何既有函数体。
   ================================================================================ */

/** 快捷键总表：帮助浮层与控制条 title 共用同一份文案（避免两处写死不同步） */
const SHORTCUTS = [
  { k: '空格', v: '播放 / 暂停' },
  { k: '← / →', v: '后退 / 前进 5 秒（进度条聚焦时仍是 5 秒，Shift 为 15 秒）' },
  { k: 'Shift+← / →', v: '上一帧 / 下一帧（暂停态单帧步进）' },
  { k: 'Shift+拖动进度条', v: '精细拖动（灵敏度 1/10，落点吸附到帧）' },
  { k: ', / .', v: '上一帧 / 下一帧（与 Shift+← / → 等价，会自动先暂停）' },
  { k: 'A', v: '设 A 点（再按一次 A 清除 A 与 B）' },
  { k: 'B', v: '设 B 点（再按一次 B 只清终点）；播放到 B 自动回跳 A' },
  { k: '↑ / ↓', v: '音量 ±10%（0–100%；100% 以上用音量滑块旁的「增益」按钮循环 1×/1.5×/2×）' },
  { k: '[ / ]', v: '减速 / 加速播放（视频倍速 0.5×–2×，按档位步进，与 A/B、逐帧互不影响）' },
  { k: 'F', v: '全屏 / 退出全屏' },
  { k: 'N / P', v: '下一部 / 上一部' },
  { k: '?', v: '打开 / 关闭本浮层' },
  { k: 'Esc', v: '先关本浮层，再关播放器' }
]

const helpVisible = ref(false)

/* ================= P5.24-A 「设置」浮层（倍速 / 增益 / 画质 / 字幕 / AB / 标记 / 快捷键） ================= */

/**
 * 一级控制条只保留 8 个按钮（用户反馈 5），其余全部收进这个浮层。
 * 面板本身是纯展示组件 PlayerSettings.vue：这里只持有「开 / 关」并按它的 emit 改真实状态；
 * 所有取值口径（档位、文案、title）仍在本文件一处生成，行为与收纳前逐字一致。
 */
const settingsOpen = ref(false)
/** 面板组件实例（点外部关闭时要它的根元素做 contains 判定） */
const settingsEl = ref(null)
/** 齿轮按钮：capture 阶段的「点外部收起」必须先跳过它，否则永远点不开 */
const gearEl = ref(null)

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value
}

/** 供页面级 Esc 与「点外部」复用：面板开着就关掉并返回 true */
function closeSettings() {
  if (!settingsOpen.value) return false
  settingsOpen.value = false
  return true
}

/** 倍速档位：值与文案由 SPEED_LEVELS / speedLabel 生成，面板只负责画 */
const speedOptions = computed(() => SPEED_LEVELS.map((s) => ({ value: s, label: speedLabel(s) })))

/** 画质档位：原画直连 + 三档实时转码 */
const qualityOptions = computed(() =>
  Q_VALUES.map((q) => ({ value: q, label: q === 'orig' ? '原画（直连）' : Q_LABELS[q] }))
)

/** 字幕：只有该片真的带字幕轨时才在面板里出现一个开关 */
const hasSub = computed(() => !!subSrc.value)
const subVisible = ref(true)

/**
 * 把当前开关落到 <track> 上：mode = showing / hidden。
 * 不动 <track> 的 src 与 default 属性 —— 所以「关掉再打开」不会重新下载字幕，
 * 与 P4-B 注入字幕轨的方式完全兼容（浏览器已加载过的那条轨直接复用）。
 */
function applySubMode() {
  const el = videoEl.value
  if (!el || !el.textTracks) return
  for (let i = 0; i < el.textTracks.length; i++) {
    el.textTracks[i].mode = subVisible.value ? 'showing' : 'hidden'
  }
}

function toggleSubVisible() {
  subVisible.value = !subVisible.value
  applySubMode()
}

/** AB 点：绝对内容秒；null = 未设 */
const abA = ref(null)
const abB = ref(null)
const abState = computed(() => ({ a: abA.value, b: abB.value }))
const abOn = computed(() => abActive(abState.value))
const abTitle = computed(() =>
  abOn.value ? 'A/B 循环中：播放到 B 自动回跳 A（再按 A 或 B 清除）' : 'A 设起点、B 设终点；两点都设好后循环生效'
)
const abText = computed(() => {
  if (abA.value == null && abB.value == null) return 'A/B'
  const a = abA.value == null ? '--:--' : fmtMark(abA.value)
  const b = abB.value == null ? '--:--' : fmtMark(abB.value)
  return (abOn.value ? '↻ ' : '') + 'A ' + a + ' · B ' + b
})

/** 逐帧：帧间隔沿用 1/30，拿到 requestVideoFrameCallback 后按实测值校正 */
const frameSec = ref(FRAME_FALLBACK_SEC)
let frameSamples = []
let rvfcHandle = 0

/** 增益档位（持久化在 localStorage['ms.gain']；100% 之上靠 WebAudio GainNode） */
const gainLevel = ref(readGainLevel(safeStorage()))
const gainFallback = ref(false)
let audioGraph = null

/**
 * 视频倍速（P4.1）：persist 在 localStorage['ms.speed']，默认 1×。
 * 只改 <video>.playbackRate，不动 currentTime —— AB 回跳、逐帧、进度记忆与埋点都读
 * 内容时间（absPos），因此倍速对它们完全透明。
 */
const speedLevel = ref(readSpeedLevel(safeStorage()))

const gainNote = computed(() =>
  gainFallback.value ? '浏览器不支持 WebAudio 增益，已降级为 0–200% 音量映射（100% 封顶）' : ''
)

const gainTitle = computed(
  () =>
    '音量增益 ' +
    gainLevel.value +
    '×（点一下切到 ' +
    nextGain(gainLevel.value) +
    '×）' +
    (gainFallback.value && gainLevel.value > 1 ? '（浏览器不支持 WebAudio，已降级为音量映射）' : '')
)

const speedTitle = computed(() => '视频倍速 ' + speedLabel(speedLevel.value) + '（快捷键 [ 减速 / ] 加速）')

// 依赖 seekDur（响应式）而不是 contentDur()（读 videoEl.duration，非响应式）：元数据晚到时刻度也能补画
const markerTickList = computed(() => buildMarkerTicks(props.markers, seekDur.value || contentDur(), fmtMark))

/** hover 命中的刻度（null = 没命中）；提示文案直接用刻度自带的 title */
const markerHover = ref(null)

/**
 * 命中判定：单点用 ±1.2% 的容差（2px 竖线太细），区间用整段宽度；
 * 距离取到刻度中心，离得最近的优先。鼠标离开进度条时清空。
 * 注意：这里只读 markerTickList（已按位置排好序），不产生任何请求。
 */
function onMarkerHover(e) {
  // 拖动中不出标记提示：浮层归拖动位置所有，两条浮层抢同一位置会抖
  if (qSeekDragging) {
    markerHover.value = null
    return
  }
  if (!markerTickList.value.length) return
  const pct = ratioFromEvent(e) * 100
  let best = null
  for (const t of markerTickList.value) {
    const mid = t.width > 0 ? t.left + t.width / 2 : t.left
    const half = Math.max(1.2, t.width / 2)
    const d = Math.abs(pct - mid)
    if (d <= half + 0.6 && (best == null || d < best.d)) best = { d, t }
  }
  markerHover.value = best ? best.t : null
}

function onMarkerLeave() {
  markerHover.value = null
}

function markerTickStyle(t) {
  const style = { left: t.left + '%', background: t.color || 'var(--accent)' }
  if (t.width > 0) style.width = t.width + '%'
  return style
}

/**
 * 标记轨上单个标记的内联样式（尺寸常量来自 playerExtras，SCSS 里不再另写一套数字）：
 * - 单点：4px 宽通高竖条（P4.3 由 3px 加粗），left% 居中（margin-left 拉回半宽）；
 * - 区间：色带按 width% 铺开 + 左右各 3px 实心边（P4.3 由 2px 加粗，border-box，边框不额外加宽）；
 * - 颜色一律用标记自带的 color，没有 color 用主题强调色（--accent），亮暗主题都跟随。
 */
function laneMarkStyle(t) {
  const color = t.color || 'var(--accent)'
  const style = {
    left: t.left + '%',
    borderColor: color
  }
  if (t.isRange) {
    style.width = t.width + '%'
    // 半透明色带 + 实心边：单点用实心色，区间用 45% 混色（P4.3 由 34% 提高，亮暗底上都看得出边界）
    style.background = 'color-mix(in srgb, ' + color + ' ' + LANE_RANGE_MIX_PCT + '%, transparent)'
  } else {
    style.width = LANE_PIN_PX + 'px'
    style.marginLeft = -(LANE_PIN_PX / 2) + 'px'
    style.background = color
  }
  return style
}

/** 标记轨 hover / 聚焦：复用进度条上方的 .p-marker-tip（文案就是刻度自带的 title） */
function onLaneHover(t) {
  markerHover.value = t || null
}

function onLaneLeave() {
  markerHover.value = null
}

/** 点击标记跳转：单点跳 pos；区间第一次跳 pos，再点同一条跳 endPos（规则在 markJumpTarget） */
let laneLastKey = ''
function onLaneClick(t) {
  const jump = markJumpTarget(t, laneLastKey)
  laneLastKey = jump.next
  if (jump.sec == null) return
  seekAbsTo(jump.sec, undefined)
}

/* ================= P4.3 标记轨尺寸变量 + 标记数量徽标 ================= */

/**
 * 标记轨的尺寸只由 playerExtras 的 LANE_* 常量决定，这里把它们落到 CSS 变量，
 * 让 SCSS 里的 height / margin-top / 边宽 / 探出量都读同一份数字（窄屏高度用 --lane-h-sm）。
 */
const laneVars = {
  '--lane-h': LANE_HEIGHT_PX + 'px',
  '--lane-h-sm': LANE_HEIGHT_PX_MOBILE + 'px',
  '--lane-gap': LANE_GAP_PX + 'px',
  '--lane-edge': LANE_EDGE_PX + 'px',
  '--lane-raise': LANE_RAISE_PX + 'px'
}

/**
 * 标记列表里点一条：跳到该标记的起点（区间 = 起点；起点 → 终点的连点语义仍由标记轨上的
 * markJumpTarget 提供）。P5.24-A：列表从「进度条上的 🚩 徽标弹出」改成设置浮层里的常显列表 ——
 * 那个徽标会变成第 9 个一级按钮，与用户要求的「一级 ≤ 8」冲突；跳转语义一行未改。
 */
function onMarkPick(t) {
  settingsOpen.value = false
  if (!t || t.startSec == null) return
  seekAbsTo(t.startSec, undefined)
}

/**
 * 点设置浮层外部收起：capture 阶段监听，先于任何按钮的 click 执行，不干扰播放器其它点击。
 * P5.24-A 起它服务的对象从「标记列表」换成「设置浮层」（同一个监听器，不再有第二个入口）。
 * 齿轮按钮本身要排除：否则「点外部收起」会在按钮的 click 之前把面板关掉，再点就永远打不开。
 */
function onDocPointerDown(e) {
  if (!settingsOpen.value) return
  const el = settingsEl.value && settingsEl.value.$el ? settingsEl.value.$el : null
  if (el && e.target && typeof el.contains === 'function' && el.contains(e.target)) return
  const gear = gearEl.value
  if (gear && e.target && typeof gear.contains === 'function' && gear.contains(e.target)) return
  settingsOpen.value = false
}

/** 换片时收起设置浮层（倍速 / 增益是全局偏好，但标记列表属于上一部片，留着会跳错位置） */
watch(
  () => (props.video ? props.video.id : ''),
  () => {
    settingsOpen.value = false
  }
)

/* ============================================ P4.4 / P5.23 控制条自动隐藏 ============================================ */

/**
 * P5.23：控制条改成**常驻叠加在视频上**（绝对定位贴底，不再占一行），所以隐藏规则从
 * 「只有全屏才淡出」扩成两种场景（判定都在 playerExtras，单测覆盖）：
 *   全屏      —— ctrlCanHide：播放中 + 指针不在控制条上 + 2.5s 无操作就淡出（既有 P4.4）；
 *   非全屏    —— ctrlCanHideDocked：指针离开视频区（.p-fs-wrap 的 mouseleave）即收起；
 *                指针在视频区内一直可见 —— 这就是用户要的「鼠标移入显示、移出隐藏」。
 * 两条路径共用同一组闸门：暂停 / 拖进度条 / 浮层展开时不隐藏。
 * P4.7：「控制条内无焦点」已从条件里删掉 —— 点一下控制条按钮焦点就留在上面（点画面不会移走，
 * <video> 不可聚焦），条件恒不满足 = 永不隐藏。焦点改由隐藏前的 willHide/blurActiveInCtrl 处理。
 */
const ctrlHidden = ref(false)
/** 指针是否停在控制条上（mouseenter / mouseleave，并用坐标 + 矩形复核） */
let ctrlHover = false
/**
 * 指针是否在视频区（.p-fs-wrap）内 —— P5.23 的隐藏判据。
 * 初值 true：首帧可见（自动播放时用户可能还没碰鼠标，不能让控制条一上来就是收起的）。
 */
let stagePointerIn = true
/** 最后一次指针位置：边界事件没来时用它兜底判断「指针其实还停在控制条上」 */
let lastPointer = { x: -1, y: -1 }

/**
 * 指针是否在控制条上（几何判定见 playerExtras.pointerInCtrlZone，单测覆盖）：
 * 以「坐标 + 矩形」为准，elementFromPoint 只作补充 —— 隐藏态 .p-ctrl 是
 * translateY(100%) + pointer-events:none，getBoundingClientRect 把它算到屏幕外，
 * 只靠 rect / 只靠 mouseenter-mouseleave 都会判错。
 */
/**
 * 指针是否落在设置浮层上（它是绝对定位向上展开的，几何上在 .p-ctrl 的矩形之外）。
 * 只按控制条矩形判「指针还在不在条上」时，指针从控制条滑到浮层的一瞬间会被判成「离开」，
 * 触发 hideOnLeave 把控制条连同刚打开的面板一起收走（用户看到的是面板闪一下）。
 * 所以隐藏判定用「控制条矩形 ∪ 浮层矩形」的并集，而不是只靠一个 class。
 */
function pointerOverSettings() {
  const el = settingsEl.value && settingsEl.value.$el ? settingsEl.value.$el : null
  if (!el) return false
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  const { x, y } = lastPointer
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** 指针是否在控制条区域（= 控制条 ∪ 设置浮层）：自动隐藏的唯一几何判据 */
function pointerOverCtrl() {
  return pointerInCtrlZone(ctrlEl.value, fsEl.value, lastPointer) || pointerOverSettings()
}

/**
 * 浮层（hover 预览 / 拖动预览 / 标记提示 / 设置面板）展开时不隐藏：否则会留下一张没有控制条的浮卡片。
 * P5.24-A：成员由「标记列表」换成「设置面板」—— 面板开着却把控制条淡出，面板会跟着一起消失。
 */
const ctrlOverlayOpen = computed(
  () => !!(previewShown.value || markerHover.value || settingsOpen.value)
)

const ctrlAuto = createCtrlAutoHide({
  // P5.23：控制条叠加在视频上 —— 非全屏也按「移出即隐藏」收起（全屏仍按 2.5s 空闲淡出）
  hideOnLeave: true,
  onChange: (hidden) => {
    ctrlHidden.value = hidden
  },
  // 隐藏时 .p-ctrl 是 pointer-events:none，边界事件未必补发：按矩形兜底，指针还在条上就不隐藏
  guard: () => !pointerOverCtrl(),
  // 隐藏前把焦点挪出控制条：opacity:0 + pointer-events:none 上不该留着焦点
  // （P4.7：焦点不再是隐藏条件，这就是它的替代保护 —— 不留焦点在看不见的控件上）
  willHide: () => {
    blurActiveInCtrl(ctrlEl.value)
  }
})

/**
 * 外部状态同步：只有这几个开关影响「能不能隐藏」，每变一次都重新计时。
 * P4.7：不再上报 focus —— 焦点钳制隐藏正是「控制条再也不隐藏」的根因。
 */
function syncCtrlState() {
  ctrlAuto.update({
    fullscreen: fsActive.value,
    playing: isPlaying.value,
    hover: ctrlHover || pointerOverCtrl(),
    dragging: qSeekDragging,
    overlay: ctrlOverlayOpen.value,
    // P5.23：false 是一次真正的「移出」—— 状态机据此立即收起（不等 2.5s）
    pointerIn: stagePointerIn
  })
}

/** 指针进入视频区：立即显示控制条（同一套 activity 计时，全屏下也复用） */
function onStageEnter(e) {
  stagePointerIn = true
  onUserActivity(e)
}

/** 指针离开视频区：收起控制条（暂停 / 拖动 / 浮层展开时由状态机自己拦下，不会误收） */
function onStageLeave() {
  stagePointerIn = false
  syncCtrlState()
}

/**
 * 任意用户操作：立即显示并重置计时。
 * P5.23：不再「非全屏直接返回」—— 非全屏同样是覆盖层，按键 / 移动都要能把控制条唤出来。
 * 同时用坐标复核悬停态：隐藏态 .p-ctrl 没有指针事件，mouseenter / mouseleave 收不到，
 * 只信边界事件会让 ctrlHover 卡在旧值（要么永不隐藏，要么唤不出来）。
 */
function onUserActivity(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  ctrlAuto.activity()
  const over = pointerOverCtrl()
  if (over !== ctrlHover) {
    ctrlHover = over
    syncCtrlState()
  }
}

function onCtrlPointerEnter(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  ctrlHover = true
  syncCtrlState()
}

function onCtrlPointerLeave(e) {
  if (e && typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY }
  ctrlHover = pointerOverCtrl()
  syncCtrlState()
}

/** 控制条内出现焦点（鼠标点按钮 / Tab 进入）→ 显示并重新计时；焦点本身不再阻止隐藏 */
function onCtrlFocusIn() {
  ctrlAuto.activity()
  syncCtrlState()
}

/**
 * 页面级快捷键（空格 / A / B / [ ] / F …）不经过播放器 DOM：文档级 keydown 也算「有操作」。
 * P5.23：非全屏也要唤出控制条 —— 否则指针停在右侧信息栏时键盘用户看不到控制条。
 */
function onDocKeydown() {
  onUserActivity()
}

watch(fsActive, syncCtrlState)
watch(isPlaying, syncCtrlState)
watch(ctrlOverlayOpen, syncCtrlState)

/* 换片 / 同片重开：控制条恢复常驻（pointerIn 复位成 true），不把上一部的隐藏状态带过来 */
watch(
  () => (props.video ? props.video.id : '') + '#' + props.openSeq,
  () => {
    ctrlHover = false
    stagePointerIn = true
    lastPointer = { x: -1, y: -1 }
    syncCtrlState()
  }
)

/** 标记 / AB 文案用的时间格式：0 秒要显示 00:00（fmtDur 对 0 返回 --:--，是给「未知时长」用的） */
function fmtMark(sec) {
  const n = Number(sec)
  const t = Math.max(0, Math.round(isFinite(n) ? n : 0))
  const m = Math.floor(t / 60)
  const s = t % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

function safeStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------ AB 循环 */

/** A / B 按钮与快捷键的唯一入口：按下即设点，再按一次清除（规则在 playerExtras.abPress 里） */
function setAbPoint(edge) {
  const next = abPress(abState.value, edge, absPos())
  abA.value = next.a
  abB.value = next.b
}

function clearAb() {
  abA.value = null
  abB.value = null
}

/**
 * 播放推进时的循环判定：到/过 B 就回跳 A。
 * 返回 true 表示这一帧已经发生回跳（调用方跳过存盘，避免把 A 点前的进度当成本次进度写库）。
 */
function abLoopJump() {
  const target = abTick(abState.value, absPos())
  if (target == null) return false
  seekAbsTo(target, true)
  return true
}

/** 跳转到绝对内容时间（转码 = 重开流，原画 = 直写 currentTime）——AB 回跳与逐帧共用 */
function seekAbsTo(abs, keepPlaying) {
  const el = videoEl.value
  if (!el || !props.video) return
  const dur = contentDur()
  let target = Number(abs) || 0
  if (dur > 0) target = Math.min(target, Math.max(0, dur - 0.05))
  target = Math.max(0, Math.round(target * 1000) / 1000)
  if (!isTranscode.value) {
    seekOrigTo(target)
    updateSeekUi()
    return
  }
  const wasPlaying = keepPlaying === true || (!el.paused && !el.ended)
  applySource(props.video, target, 0)
  if (wasPlaying) tryPlay()
}

/* -------------------------------------------------------------- 逐帧 */

/** 单帧步进：暂停态才有意义，播放中先暂停；转码模式按内容时间重开流（与 seekRel 同一条路径） */
function stepFrame(dir) {
  const el = videoEl.value
  if (!el) return
  if (!el.paused) el.pause()
  const cur = absPos()
  // P5.16：知道帧率就按**帧号**步进（frameOf → ±1 → 帧时间），比 1/30 的近似步长精确：
  // 帧率未知时沿用 P4-B 的近似（rvfc 实测 / 1/30 兜底）。
  const fps = frameFps.value
  const next = fps
    ? snapToFrame(frameToSec(frameOf(cur, fps) + dir, fps), fps)
    : frameStep(cur, dir, frameSec.value, contentDur())
  if (fps ? sameFrame(next, cur, fps) : Math.abs(next - cur) < 0.0005) return
  seekAbsTo(next, false)
  sampleFrameDuration()
}

/**
 * 用 requestVideoFrameCallback 的 mediaTime 校正帧间隔：
 * 暂停态每 seek 一帧回调一次，攒够两帧就能算出真实间隔；两帧的差值异常则保留 1/30。
 */
function sampleFrameDuration() {
  const el = videoEl.value
  if (!el || typeof el.requestVideoFrameCallback !== 'function' || rvfcHandle) return
  const onFrame = (now, meta) => {
    rvfcHandle = 0
    if (!meta || !isFinite(meta.mediaTime)) return
    frameSamples.push(meta.mediaTime)
    if (frameSamples.length > 4) frameSamples.shift()
    if (frameSamples.length >= 2) frameSec.value = frameStepSize(frameSamples, FRAME_FALLBACK_SEC)
  }
  rvfcHandle = el.requestVideoFrameCallback(onFrame)
}

function stopFrameSampling() {
  const el = videoEl.value
  if (rvfcHandle && el && typeof el.cancelVideoFrameCallback === 'function') {
    el.cancelVideoFrameCallback(rvfcHandle)
  }
  rvfcHandle = 0
  frameSamples = []
}

/* ------------------------------------------------------------ 音量增益 */

function audioCtor() {
  if (typeof window === 'undefined') return null
  return window.AudioContext || window.webkitAudioContext || null
}

/** 增益档位：>1 才需要 WebAudio；浏览器拒绝时置 gainFallback 并说明（音量仍走 <video>.volume） */
function setGain(level) {
  const next = normalizeGain(level)
  gainLevel.value = next
  writeGainLevel(safeStorage(), next)
  if (next <= 1) {
    applyGain(audioGraph, 1)
    return
  }
  if (!audioGraph) {
    audioGraph = createGainGraph(audioCtor(), videoEl.value, next)
    if (!audioGraph.ok) {
      audioGraph = null
      gainFallback.value = true
      const el = videoEl.value
      if (el) {
        el.volume = 1
        el.muted = false
      }
      onVolumeChange()
      return
    }
  }
  if (!applyGain(audioGraph, next)) {
    gainFallback.value = true
    return
  }
  const el = videoEl.value
  if (el && el.muted) el.muted = false
  onVolumeChange()
}

/** 增益循环按钮的唯一入口：1× → 1.5× → 2× → 1×（档位切换仍走 setGain，行为与 P4-B 完全一致） */
function cycleGain() {
  setGain(nextGain(gainLevel.value))
}

/* ------------------------------------------------------------ 视频倍速 */

/** 把当前档位落到 <video> 上：playbackRate 管这一次播放，defaultPlaybackRate 兜住之后的 load */
function applySpeed() {
  const el = videoEl.value
  if (!el) return
  const rate = normalizeSpeed(speedLevel.value)
  try {
    el.defaultPlaybackRate = rate
    el.playbackRate = rate
  } catch {
    /* 忽略：个别浏览器在未就绪的流上拒绝赋值，下一次 applySource 会再落一次 */
  }
}

/** 倍速唯一写入口：归一化 → 持久化 → 落到元素（下拉与快捷键都走这里） */
function setSpeed(level) {
  speedLevel.value = normalizeSpeed(level)
  writeSpeedLevel(safeStorage(), speedLevel.value)
  applySpeed()
}



/** 快捷键 [ / ]：dir<0 减速、dir>0 加速（档位表内步进，夹在 0.5×–2×） */
function changeSpeed(dir) {
  setSpeed(speedStep(speedLevel.value, dir))
}

function closeAudioGraph() {
  const graph = audioGraph
  audioGraph = null
  if (!graph) return
  try {
    if (graph.source && typeof graph.source.disconnect === 'function') graph.source.disconnect()
    if (graph.node && typeof graph.node.disconnect === 'function') graph.node.disconnect()
    if (graph.ctx && typeof graph.ctx.close === 'function') {
      const p = graph.ctx.close()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    }
  } catch {
    /* 忽略：关闭失败只影响下一次创建，不影响音频输出 */
  }
}

/* -------------------------------------------------------------- 帮助 */

function toggleHelp() {
  helpVisible.value = !helpVisible.value
}

/**
 * 供页面级 Esc 使用：按「最上面那一层」逐层关闭，返回 true 表示这次 Esc 已被消费。
 * P5.24-A：设置浮层也是浮层，所以顺序是 设置面板 → 快捷键说明 → 交给页面关播放器。
 * 页面侧（VideoPage.onKey）只认 closeHelp 一个入口，不需要跟着改。
 */
function closeHelp() {
  if (closeSettings()) return true
  if (!helpVisible.value) return false
  helpVisible.value = false
  return true
}

/* ---------------------------------------------------------------- video 事件 */

function onPlay() {
  isPlaying.value = true
  props.tracker.trackPlayStart(props.video.id)
  // P5.22：起播即接上逐帧进度（幂等：闸门关着就不起，不会排出第二个循环）
  seekClock.start()
}

function onPlaying() {
  isPlaying.value = true
  tapVisible.value = false
  endQHint()
  // P5.22：缓冲结束真正开始推进（seek 之后只有 playing 事件，play 不一定再来）
  seekClock.start()
}

/** 点画面切换播放/暂停：移除原生 controls 后补回等价能力 */
function onVideoClick() {
  togglePlay()
}

function onLoadedData() {
  endQHint()
  updateSeekUi()
}

function onDurationChange() {
  updateSeekUi()
}

/** 静音 / 音量滑块的唯一同步点：键盘 ↑/↓ 调 el.volume 时也会走到这里 */
function onVolumeChange() {
  const el = videoEl.value
  if (!el) return
  volume.value = isFinite(el.volume) ? el.volume : 1
  muted.value = !!el.muted
}

function onVolumeInput(e) {
  const el = videoEl.value
  if (!el) return
  const v = Math.max(0, Math.min(1, Number(e.target.value) || 0))
  el.volume = v
  el.muted = v <= 0
  onVolumeChange()
}

function toggleMute() {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
  if (!el.muted && el.volume <= 0) el.volume = 0.5
  onVolumeChange()
}

function onLoadedMetadata() {
  updateSeekUi()
  // P5.24-A：字幕轨要等元数据到达才进 textTracks，开关状态在这里落一次（默认显示）
  applySubMode()
  if (!pendingSeek) return
  const abs = pendingSeek
  pendingSeek = 0
  const el = videoEl.value
  if (!el) return
  const rel = isTranscode.value ? Math.max(0, abs - streamStart) : abs
  const d = el.duration
  const target = !isTranscode.value && isFinite(d) && d > 0 && rel >= d - 2 ? 0 : rel
  try {
    el.currentTime = target
  } catch {
    /* 忽略：部分浏览器对未就绪的流拒绝赋值 */
  }
}

function onTimeUpdate() {
  updateSeekUi()
  // P4-B：到/过 B 立即回跳 A，这一帧不再走存盘（A 点前的位置不该被当成观看进度）
  if (abLoopJump()) return
  const now = Date.now()
  if (now - lastPosWrite >= 3000) {
    lastPosWrite = now
    savePosFor(props.video)
  }
  if (now - lastRecentPush >= 5000) pushRecentServer()
}

function onPause() {
  isPlaying.value = false
  // P5.22：暂停先停 rAF（绝不空转），再把位置与文本对齐到暂停那一帧的准确值
  seekClock.stop()
  settleProgressExact()
  savePosFor(props.video)
  pushRecentServer()
  settlePlay()
}

function onEnded() {
  isPlaying.value = false
  // P5.22：播完同样停表并对齐（末帧位置要精确，不能停在 40ms 之前）
  seekClock.stop()
  settleProgressExact()
  const v = props.video
  if (!v) return
  emit('clear-pos', v.id)
  const dur = contentDur(v) || v.dur || 0
  emit('push-recent', { id: v.id, pos: 0, dur, force: true })
  settlePlay()
}

/** 转码模式下浏览器发起的 seeking：片内偏移超过 5 秒就从新时间点重开流；原画直接由 Range 处理 */
function onSeeking() {
  if (!isTranscode.value || !props.video) return
  if (Date.now() - lastQSrcAt < 600) return // 换源刚发生，忽略随之而来的 seeking
  const el = videoEl.value
  if (!el) return
  const rel = el.currentTime || 0
  if (rel <= 5) return
  const wasPlaying = !el.paused && !el.ended
  applySource(props.video, streamStart + rel, 0)
  if (wasPlaying) tryPlay()
}

function onError() {
  tapVisible.value = false
  endQHint()
  // 转码流取不到（404 / 429 转码忙 / 503 ffmpeg 不可用）→ 回退原画，别让用户黑屏
  if (isTranscode.value && props.video && !qFallback) {
    qFallback = true
    const abs = absPos()
    curQ.value = 'orig'
    emit('update:quality', 'orig')
    updateSeekUi()
    applySource(props.video, 0, abs)
    tryPlay()
    return
  }
  const el = videoEl.value
  if (props.video && el && el.getAttribute('src')) warnVisible.value = true
}

/* ---------------------------------------------------------------- 交互 */

function onTapPlay() {
  tapVisible.value = false
  tryPlay()
}

function onRestart() {
  if (isTranscode.value && props.video) applySource(props.video, 0, 0) // 转码「从头」= 从 t=0 重开流
  else if (videoEl.value) videoEl.value.currentTime = 0
  restartVisible.value = false
  tryPlay()
  if (props.video) emit('clear-pos', props.video.id)
}

function togglePlay() {
  const el = videoEl.value
  if (!el) return
  if (el.paused) tryPlay()
  else el.pause()
}

/** ←/→：原画走原生跳转，转码流只能从新时间点重开流（app.js:1058-1072） */
function seekRel(delta) {
  const el = videoEl.value
  if (!el || !props.video) return
  if (isTranscode.value) {
    const dur = contentDur() || 0
    const target = Math.max(0, Math.min(dur > 0 ? dur : 1e9, absPos() + delta))
    const wasPlaying = !el.paused && !el.ended
    applySource(props.video, target, 0)
    if (wasPlaying) tryPlay()
    return
  }
  const d = el.duration
  const max = isFinite(d) && d > 0 ? d : 1e9
  // P5.16：←/→ 与页面级 5 秒跳转的落点也吸到帧栅格（fps 未知时 snapToFrame 原样返回）
  const target = snapToFrame(Math.max(0, Math.min(max, (el.currentTime || 0) + delta)), frameFps.value)
  el.currentTime = target
  seekPos.value = seekPosOf(target)
}

function adjustVolume(delta) {
  const el = videoEl.value
  if (el) el.volume = Math.max(0, Math.min(1, el.volume + delta))
}

/**
 * 全屏（P4.3 修复「全屏后没有控制栏」）：
 *   旧实现请求的是 .p-stage —— 它**只包 <video>**，自绘控制栏 .p-ctrl 是它的兄弟节点，
 *   一进全屏浏览器只显示被请求的那个元素，控制栏于是被挡在屏幕外（这就是病症）。
 *   现在请求的是 .p-fs-wrap（包 video + 控制栏），并给它 :fullscreen 下 display:flex / column / 黑底，
 *   控制栏固定在底部，进度条与其中的标记轨都可见。退出（F / Esc / 浏览器手势）由
 *   fullscreenchange → onFsChange 同步按钮图标，:fullscreen 样式失效后布局自动恢复。
 */
function toggleFullscreen() {
  const d = document
  const exit = d.exitFullscreen || d.webkitExitFullscreen
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    if (exit) {
      const p = exit.call(d)
      if (p && p.catch) p.catch(() => {})
    }
    return
  }
  const wrap = fsEl.value || stageEl.value
  if (!wrap) return
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen
  if (req) {
    const p = req.call(wrap)
    if (p && p.catch) p.catch(() => {})
  } else if (videoEl.value && videoEl.value.webkitEnterFullscreen) {
    // iOS Safari：不支持元素全屏（requestFullscreen 在 div 上不可用），退化为「视频本身全屏」，
    // 此时控制栏由系统播放器提供（含系统进度条），自绘控制栏不参与；退出后按钮图标由
    // video 的 webkitbegin/endfullscreen 事件同步（见 onIosFsIn / onIosFsOut）。
    videoEl.value.webkitEnterFullscreen()
  }
}

/** 页面隐藏 / 卸载时只结算埋点（位置存盘由 onBeforeUnmount 负责，与 app.js tkPageHide 等价） */
function settle() {
  const v = openedVideo || props.video
  if (v) settlePlay(v.id)
}

defineExpose({
  togglePlay,
  seekRel,
  adjustVolume,
  toggleFullscreen,
  settle,
  /* ---- P4-B：页面级快捷键（A / B / , . / Shift+方向 / ? / Esc）走这几个入口 ---- */
  setAbPoint,
  clearAb,
  stepFrame,
  toggleHelp,
  closeHelp,
  /** P4.1：页面级快捷键 [ / ] 的入口（dir<0 减速、dir>0 加速） */
  changeSpeed,
  /** 当前内容位置（秒）：信息抽屉「在当前时间加标记」的起点；转码流已加上流起点 */
  getCurrentTime: absPos,
  /** P4.5：内容总时长（秒）：信息抽屉回填标记「区间终点」与片尾夹取用；转码流取索引里的 dur */
  getDuration: contentDur,
  /* ---- P5.23：右侧常驻信息栏的展开 / 折叠（页面「信息」入口与面板自己的收起按钮都走这里） ---- */
  openSide,
  closeSide,
  toggleSide,
  isSideOpen: () => sideOpen.value
})
</script>

<style lang="scss" scoped>
.player {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
}

/* P5.23 播放页布局：头部(.p-head)不动，其下是「左侧视频区 + 右侧常驻信息栏」的一行。
   flex 关系（外 → 内）：
     .player (column) → .p-head / .p-body / .p-help(浮层)
     .p-body (row)    → .p-main + .p-side
     .p-main (column) → .p-fs-wrap (视频，flex:1 1 0 + min-height:0)   ← P5.24-A 起唯一子元素
   舞台高度只由「播放器高度 − 头部」决定（.p-tags 标签条已删除：它是 .p-main 里唯一
   的 flex:0 0 auto 兄弟，实测占 44.19px，删掉这 44px 全部回到舞台）：.p-fs-wrap 的 flex-basis 依旧是 0（P5.18），
   右栏与舞台是同一行的两个兄弟，互不参与对方的尺寸计算。 */
.p-body {
  /* P5.24：右栏宽度提到 .p-body 上 —— 右栏与「信息栏开关」共用同一个值，
     开关的 right 因此恒等于信息栏左边缘：展开 / 收起两种状态下 rect 完全一致（位置不跳）。 */
  --p-side-w: clamp(320px, 26vw, 420px);
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  position: relative;
}

.p-main {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 右侧常驻信息栏：宽度落在 320–420px（窄视口 320、宽视口封顶 420，中间跟 26vw）。
   独立纵向滚动（overflow-y:auto），是 flex 里的一个兄弟列 —— 不覆盖视频、不挤压舞台高度。 */
.p-side {
  flex: 0 0 var(--p-side-w);
  width: var(--p-side-w);
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-2);
  border-left: 1px solid var(--line);
  transition: flex-basis 0.18s ease, width 0.18s ease;
}

/* P5.24：细滚动条（6px）默认半透明，指针进栏才加深 —— 亮暗两套主题都只用 --fg 混色，不写死颜色。
   注意：Chromium 里只要写了标准属性 scrollbar-width（非 auto）就会忽略 ::-webkit-scrollbar 的宽度
   （实测会变成 11px），所以 6px 只由下面这组伪元素负责；标准属性用 @supports 只留给 Firefox。 */
@supports not selector(::-webkit-scrollbar) {
  .p-side {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fg) 16%, transparent) transparent;
  }

  .p-side:hover {
    scrollbar-color: color-mix(in srgb, var(--fg) 34%, transparent) transparent;
  }
}

.p-side::-webkit-scrollbar {
  width: 6px;
}

.p-side::-webkit-scrollbar-track {
  background: transparent;
}

.p-side::-webkit-scrollbar-thumb {
  border-radius: 3px;
  background: color-mix(in srgb, var(--fg) 16%, transparent);
}

.p-side:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--fg) 34%, transparent);
}

/* 折叠 = 宽度归零（不是 visibility / 负 margin）：视频随即整宽铺满，两者不重叠 */
.p-side.is-closed {
  flex-basis: 0;
  width: 0;
  border-left: 0;
  overflow: hidden;
}

/* P5.24 信息栏开关：竖条贴信息栏左边缘中部（20×64，只在左侧圆角），一个 chevron，无文字。
   P5.24-A：定位随状态变化 —— 展开态贴栏左边缘（right: --p-side-w），收起态贴视频右边缘（right: 0）。
   收起时栏宽归零、视频整宽铺满，若仍留在原落点，按钮会浮在画面中间（实测距右边缘 412px），
   用户原话「肯定要移动的呀，不然飘在视频上面干嘛」。
   right 参与过渡（与 opacity 同节奏 0.18s）→ 两态之间是平滑滑动，不是瞬移。
   默认半透明（--tog-op 0.34），指针移入信息栏或按钮本身时 .is-shown → 1。 */
.p-side-toggle {
  --tog-op: 0.34;
  position: absolute;
  right: var(--p-side-w);
  top: 50%;
  transform: translateY(-50%);
  z-index: 30;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 64px;
  padding: 0;
  border: 1px solid var(--line);
  border-right: 0;
  border-radius: 10px 0 0 10px;
  background: color-mix(in srgb, var(--bg-2) 82%, transparent);
  color: var(--fg);
  font: inherit;
  cursor: pointer;
  opacity: var(--tog-op);
  transition: right 0.18s ease, opacity 0.18s ease, background 0.18s ease, border-color 0.18s ease,
    color 0.18s ease;
}

/* 收起态：贴视频 / 视口右边缘。:not(.is-open) 而不是另加一个类 —— 状态只有 sideOpen 一个真值，
   窄屏浮层（≤1199 与 ≤767）也走同一条规则：展开贴浮层左边缘、收起贴右边缘。 */
.p-side-toggle:not(.is-open) {
  right: 0;
}

.p-side-toggle.is-shown,
.p-side-toggle:hover {
  --tog-op: 1;
}

.p-side-toggle:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--bg-2) 96%, transparent);
}

.p-side-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  --tog-op: 1;
}

.p-side-toggle-i {
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
}

/* 窄屏（<1200px）：右栏改浮层 —— 绝对定位滑出、覆盖视频，视频宽度不受影响（不挤压）。
   <768px 再放宽到整屏浮层。断点必须与脚本里的 narrowMq 一致。 */
@media (max-width: 1199px) {
  /* 浮层是同一个「信息栏」概念：开关仍按右栏宽度算左边缘，展开 / 收起不跳 */
  .p-body {
    --p-side-w: min(92vw, 420px);
  }

  /* 浮层收起时整块挪到屏幕外 → 开关必须一直可见（不能靠 hover 才发现） */
  .p-side-toggle {
    --tog-op: 0.82;
  }

  .p-side {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    flex: 0 0 auto;
    width: min(92vw, 420px);
    max-width: min(92vw, 420px);
    border-left: 1px solid var(--line);
    box-shadow: -12px 0 24px rgba(0, 0, 0, 0.28);
    transform: translateX(100%);
    transition: transform 0.2s ease;
  }

  /* 浮层收起 = 挪出屏幕右侧：宽度保持、不参与 flex（absolute 本身就不占位） */
  .p-side.is-closed {
    flex-basis: auto;
    width: min(92vw, 420px);
    overflow-y: auto;
    overflow-x: hidden;
    border-left: 1px solid var(--line);
    transform: translateX(100%);
  }

  .p-side:not(.is-closed) {
    transform: none;
  }

  /* 浮层展开时的遮罩：点一下收起；z-index 低于右栏，面板本身仍可点 */
  .p-side-scrim {
    position: absolute;
    inset: 0;
    z-index: 8;
    background: rgba(0, 0, 0, 0.38);
  }
}

@media (max-width: 767px) {
  .p-side,
  .p-side.is-closed {
    width: 100%;
    max-width: 100%;
  }

  /* 浮层占满全宽（左边缘 = 视口左边缘）→ 开关改贴视口右边缘，仍是同一条竖条 */
  .p-body {
    --p-side-w: 0px;
  }
}

.p-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 16px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
}

.p-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* P5.24-A：标题加粗 + 单行省略 —— 长标题不许把右侧三组按钮挤走 */
.p-title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* P5.24-A：一行元信息，两两之间用中点分隔。中点由 ::before 生成而不是写进文案，
   这样屏幕阅读器不会多念一个「·」；窄屏换行时中点跟着上一项走，不会孤零零掉到行首。 */
.p-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-width: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.p-meta-i {
  white-space: nowrap;
}

.p-meta-i + .p-meta-i::before {
  content: '·';
  margin: 0 7px;
  color: var(--fg-dim);
  opacity: 0.8;
}

/* P5.24-A：右侧按钮分三组（收藏 | ‹上一部 / 下一部› | 关闭 Esc），组间 1px 竖线，
   组内 6px —— 按钮不再是一排等距的方块，层次一眼可读 */
.p-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
}

.p-act-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.p-act-sep {
  flex: 0 0 auto;
  width: 1px;
  height: 18px;
  background: var(--line);
}

/* P5.24-A：按钮统一高度 / 圆角 / 内边距，宽度不再随文案长短跳动 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 30px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-3);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}

.btn:hover {
  border-color: var(--line-2);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.p-fav.on {
  color: var(--warn);
  border-color: var(--warn);
  background: rgba(255, 201, 119, 0.14);
}

/* 关闭键内嵌的 Esc 提示：等宽小胶囊，明说「按 Esc 也一样」 */
.p-kbd {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: 0.4px;
}

.p-close {
  font-weight: 600;
}

.p-warn {
  padding: 9px 14px;
  background: rgba(255, 93, 93, 0.18);
  border-bottom: 1px solid rgba(255, 93, 93, 0.45);
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
}

/* 自绘控制条：原画（直连）与转码共用一套；颜色只取 mediaTheme 变量（--bg/--fg/--line/--accent → --qt-*）。
   P5.23：改成**常驻叠加层** —— 绝对定位贴 .p-fs-wrap 下沿（= 画面下沿），脱离文档流，
   不再像改动前那样作为 flex 的下一行占掉视频高度（旧做法视频区 = 舞台 + 控制条两段）。
   半透明底 + 背衬模糊：亮暗两套主题都能读，也不会把画面切出一条硬边。 */
/* 自绘控制条：原画（直连）与转码共用一套；颜色只取 mediaTheme 变量（--bg/--fg/--line/--accent → --qt-*）。
   P5.23：改成**常驻叠加层**（绝对定位贴 .p-fs-wrap 下沿），脱离文档流，不占视频高度。

   P5.24-A（用户反馈 3「透明度降到极低」）：底座不再是 color-mix(--bg-2 86%) 那条实心色带。
   取值与依据：
     - 底色 alpha = .18（亮）/ .20（暗），都远低于验收上限 .30 —— 画面可视面积基本不被侵占；
     - 亮色主题额外铺一层 rgba(255,255,255,.06) 的「相反叠层」（写在 background-image，
       不动 background-color 的 alpha，验收读到的仍是 .18）；
     - 只留一条 1px 发丝线定界，边界不再是色块；
     - 可读性不再由底座承担：底座一旦接近全透明，就必然出现「白字压亮帧」的最坏情况
       （.20 的底座叠在纯白帧上仍是 204,204,204，白字只有 1.6:1）。所以每个控件自带深色 chip
       （--p-chip = rgba(0,0,0,.46)）+ 白色描边 + 投影：最坏背衬下白字 5.09:1（暗）/ 4.78:1（亮）。 */
.p-ctrl {
  /* 控制条专属令牌：亮色是默认，暗色在文件末尾的 html.dark 块里覆盖 */
  --p-scrim: rgba(0, 0, 0, 0.18);
  --p-veil: rgba(255, 255, 255, 0.06);
  --p-hair: rgba(0, 0, 0, 0.08);
  --p-ink: #fff;
  --p-chip: rgba(0, 0, 0, 0.46);
  --p-chip-hover: rgba(0, 0, 0, 0.58);
  --p-edge: rgba(255, 255, 255, 0.3);
  --p-edge-hover: rgba(255, 255, 255, 0.6);
  --p-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 14px;
  background-color: var(--p-scrim);
  background-image: linear-gradient(var(--p-veil), var(--p-veil));
  backdrop-filter: blur(9px) saturate(1.05);
  -webkit-backdrop-filter: blur(9px) saturate(1.05);
  border-top: 1px solid var(--p-hair);
  min-width: 0;
  overflow: visible;
  /* P4.4 / P5.23：自动隐藏的淡出与下沉位移一并过渡（隐藏态定义见 .p-fs-wrap.is-ctrl-hidden） */
  transition: opacity 0.2s ease, transform 0.2s ease;
}

/* P5.24-A：一条信息层级线 —— 左（播放 / 音量 / 时间）· 中（进度，唯一可伸缩）· 右（功能）。
   flex-wrap 是窄屏的兜底：360px 上三组会自然折行，而不是横向溢出。 */
.p-ctrlline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--p-ink);
}

.p-grp {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.p-grp-left,
.p-grp-right {
  flex: 0 0 auto;
}

/* 中组是唯一的弹性项：进度条拿走所有剩余宽度 */
.p-grp-mid {
  flex: 1 1 260px;
  min-width: 0;
  gap: 8px;
}

/* 右组里的分组竖线（逐帧 | 前后跳 | 设置 + 全屏） */
.p-sep {
  flex: 0 0 auto;
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.28);
}



/* P5.24-A：按钮自身承担可读性 —— 深色 chip + 白色描边 + 投影，压在亮帧上也读得出；
   底色接近透明之后，这一层才是「不影响按钮可见」的那一半（另一半是对比度数值）。 */
.p-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--p-edge);
  border-radius: 8px;
  background: var(--p-chip);
  color: var(--p-ink);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  text-shadow: var(--p-shadow);
  box-shadow: var(--p-shadow);
  transition: background 0.12s ease, border-color 0.12s ease;
}

.p-btn:hover {
  background: var(--p-chip-hover);
  border-color: var(--p-edge-hover);
}

.p-btn:active {
  background: var(--p-chip-hover);
}

.p-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 齿轮：开着的时候保持高亮，用户能看出「面板是我点开的」 */
.p-gear.on {
  border-color: var(--accent);
  background: var(--p-chip-hover);
  box-shadow: var(--p-shadow), inset 0 0 0 1px var(--accent);
}

.p-btn-play {
  min-width: 40px;
  border-color: var(--p-edge-hover);
  font-size: 14px;
}

/* 音量滑块：轨道是原生的（accent-color 跟随主题），外面套一层 chip 保证「轨道本身」在
   亮帧 / 暗帧上都看得见（暗色主题下原生轨道是深灰，直接压在黑画面里会看不见） */
.p-vol {
  flex-shrink: 0;
  width: 86px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--p-chip);
  box-shadow: var(--p-shadow);
  accent-color: var(--accent);
  cursor: pointer;
}

.p-vol:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}











/* 进度条行：原画直写 currentTime，转码重开流 + pendingSeek，UI 同一套 */


/* P4.1：进度条与标记轨竖排成一列；.p-seekbar 仍是行布局（时间码在右） */
.p-seek-col {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 进度条容器：hover 卡片 / 拖动预览 / 1px 指示线都挂在这一层（position:relative 的定位基准）。
   mousemove 挂在这一层（20px 命中带），而不是只有 4px 高的 range 轨道。
   P4.1：轨道改为贴底（align-items:flex-end）—— 20px 命中带下半部分空出来的位置正好给标记轨，
   标记轨与 4px 轨道之间才是真正的 2px 间距；hover 卡片仍锚在容器上方，定位不变 */
.p-seekwrap {
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  min-height: 20px;
  min-width: 0;
  display: flex;
  align-items: flex-end;
  cursor: pointer;
  overflow: visible;
}

/* P4.4 进度条：thumb 尺寸改由 --seek-thumb 决定（值来自 playerExtras.SEEK_THUMB_PX，
   MediaPlayer 注入到 .p-seek-col），并自己接管 thumb / 轨道绘制。
   这样「可视轨道 = 元素宽 - thumb 宽（两端各半个 thumb）」是确定值 —— 标记轨按 var(--thumb-r)
   左右内缩即可与滑块中心逐像素对齐，不受各浏览器原生 thumb 尺寸影响（实测 Blink 原生 16px，
   比设计值大 2px，正是用户看到的两端错位）。
   轨道用渐变自绘填充：--p 是已播放百分比（seekFillStyle），亮暗主题都只读 mediaTheme 变量。 */
.p-seek {
  flex: 1;
  min-width: 0;
  height: 4px;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: visible;
  border-radius: 2px;
  cursor: pointer;
  -webkit-appearance: none;
  appearance: none;
  background: linear-gradient(
    to right,
    var(--accent) 0 var(--p, 0%),
    color-mix(in srgb, var(--fg-dim) 38%, transparent) var(--p, 0%) 100%
  );
}

/* thumb：直径 = --seek-thumb（桌面 14px / 窄屏 10px），压在 4px 轨道正中（4px 高的元素盒，
   thumb 允许溢出，Chrome / Edge / Safari 与 Gecko 都按轨道中心摆放） */
.p-seek::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: var(--seek-thumb, 14px);
  height: var(--seek-thumb, 14px);
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
}

/* Gecko：轨道默认会盖住 input 自己的渐变，置空让填充透出来；thumb 同一尺寸 */
.p-seek::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: transparent;
}

.p-seek::-moz-range-progress {
  background: transparent;
}

.p-seek::-moz-range-thumb {
  width: var(--seek-thumb, 14px);
  height: var(--seek-thumb, 14px);
  border: 0;
  border-radius: 50%;
  background: var(--accent);
}

.p-seek:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

/* P5.14 悬停浮层（只在 hover 时出现，拖动中不出；有 pv2 显示预览片段，无 pv2 降级精灵图切片）。
   160×90，贴在控制条上方；颜色只取 mediaTheme 变量（= --qt-* 映射），亮暗都可读。
   z-index 6 > 控制条 5（P4.6 的口径），全屏下也在控制条之上，父级都不裁剪（见 .p-seekwrap） */
.p-preview {
  position: absolute;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  z-index: 6;
  border: 1px solid var(--line-2);
  border-radius: var(--radius);
  /* P5.18：底色必须是深色。--bg-3 / --bg-2 在亮色主题下是接近白的灰，
     而这一格里装的是**视频画面**（精灵图切片 / 精确帧 / 预览片段），
     任何一层没就绪时露出的就是那块白底 —— 用户反馈的「预览框白屏」。 */
  background: #000;
  box-shadow: 0 6px 18px var(--accent-soft);
  overflow: hidden;
  pointer-events: none;
}

/* 1px 指示线：悬停位置提示；只有能出预览的片子才会渲染，其它片子零浮层 */
.p-hover-line {
  position: absolute;
  top: -6px;
  bottom: -6px;
  width: 1px;
  background: var(--accent);
  opacity: 0.9;
  pointer-events: none;
  z-index: 5;
}

/* 精灵图单格也是 160×90：background-size 2000% 2000%（20 列 × 20 行）+ background-position 百分比切格，
   不写死像素，卡片缩放时格子仍对齐 */
.p-hover-img {
  width: 160px;
  height: 90px;
  background-repeat: no-repeat;
  /* P5.18：深色底（原来是 --bg-3，亮色主题下 ≈ 白 → 精灵图解码完成前就是一块白屏） */
  background-color: #000;
}

/* P5.15 精确帧层：绝对铺满浮层，盖在精灵图切片 / 预览片段之上（兜底先出、真帧后到）。
   480 宽 jpeg 在 160×90 的卡片里按 cover 裁切，与精灵图单格同尺寸，布局不跳动。 */
.p-hover-exact {
  position: absolute;
  inset: 0;
  z-index: 1;
  background-repeat: no-repeat;
  background-size: cover;
  background-position: center;
  /* P5.18：深色底 + 只有 decode() 落地后才会挂上来（见 preloadImage），
     于是「精确帧还没出来」的那一瞬露出的是精灵图/黑底，不是白屏。 */
  background-color: #000;
}

/* P5.21 精确帧指示点：右上角 6px 实心点，只在真帧已盖上时出现
   （用户能分辨这是真帧还是精灵图兜底；精灵图阶段整块不渲染）。
   视觉上只是一个点，语义没有丢：role="img" + aria-label/title 仍读得到「精确帧」。
   强调色 + 半透明黑描边 + 阴影，浅色画面和深色画面都能看见；z-index 2 压在画面层(1)之上、
   底部时间条(3)之下，且 6px 边角不会碰到画面主体与时间条。 */
.p-preview-exact {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 2;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  /* 1px 深色描边（亮背景下有轮廓） + 一点外阴影（暗背景下有分离感） */
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.55),
    0 0 3px rgba(0, 0, 0, 0.45);
  /* 纯指示器，不吃鼠标事件（不要挡住预览框上的其它交互） */
  pointer-events: none;
  /* P5.21：只在挂上来时淡入一次，之后不再有任何动画（不闪烁） */
  animation: p-exact-dot-in 0.14s ease-out both;
}

@keyframes p-exact-dot-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* 降低动态偏好：直接出现，不做淡入 */
@media (prefers-reduced-motion: reduce) {
  .p-preview-exact {
    animation: none;
  }
}

/* 预览片段：与精灵图单格同尺寸，画面比例不一致时裁切填满。
   is-frame-ready 之前整块先不着色（见 .p-preview-v 的 opacity）：片段刚 load 完、
   seek 还没落地的那个空档浏览器没有任何可显示帧，过早显示就是一块黑帧（P5.5 用户反馈） */
.p-preview-v {
  display: block;
  width: 160px;
  height: 90px;
  object-fit: cover;
  background: #000;
  opacity: 0;
  transition: opacity 0.12s linear;
}

.p-preview.is-frame-ready .p-preview-v {
  opacity: 1;
}

/* P5.19：浮层底部时间条（.p-preview-bar / -t / -sub）的样式已随组件搬到 PreviewTimeBar.vue —
   大字在那里渲染「带帧号的内容时间」，样式跟着 DOM 走才不会两边各写一套。 */

/* P5.19 进度条右侧时间码：**一直**显示「位置 hh:mm:ss:ff / 总时长 hh:mm:ss:ff」。
   一行不换行（溢出时宁可缩短轨道也不能把时间码折成两行 —— 折行后和标记轨、浮层锚点全错位）。 */
/* P5.19：时间码**一直**显示帧号（播放 / 暂停 / 拖动同一条）；
   P5.24-A：chip 化 —— 裸白字直接压在近乎透明的底座上，最坏背衬（纯白帧）只有 1.6:1，
   套上 --p-chip 之后是 5.09:1（暗）/ 4.78:1（亮），和按钮同一口径。 */
.p-seek-now {
  flex: 0 0 auto;
  padding: 3px 8px;
  border-radius: 7px;
  background: var(--p-chip);
  color: var(--p-ink);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
  white-space: nowrap;
  text-shadow: var(--p-shadow);
  box-shadow: var(--p-shadow);
}

/* 知道帧率时（P5.16 起就有的口径，P5.19 起常亮）：等宽数字 + 高对比文字色，帧号是这一刻最重要的信息。
   P5.24-A：这里原来是 color: var(--fg)（主题文字色）—— 压在近乎透明的底座上时，
   亮色主题下深灰字压深色画面只有 1.3:1 左右。统一走 --p-ink（chip 上的白字），
   与按钮 / AB 读数同一口径（最坏背衬 4.78:1 / 5.09:1）。 */
.p-seek-now.is-frame {
  color: var(--p-ink);
  letter-spacing: 0.2px;
}

/* P5.16「Shift+拖动 = 精细」提示：绝对贴在进度条上方，pointer-events:none 所以不挡拖动、不挡浮层。
   宽度不够时（窄屏）样式兜底隐藏 —— 移动端本来也没有 Shift。 */
.p-fine-tip {
  position: absolute;
  right: 0;
  top: -16px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10.5px;
  line-height: 14px;
  color: var(--fg-dim);
  background: var(--bg-3);
  pointer-events: none;
  white-space: nowrap;
  z-index: 5;
}

/* 精细拖动进行中：提示变成「已生效」的强调色，用户能确认手势被接管了 */
.p-fine-tip.on {
  color: var(--accent);
  border: 1px solid var(--accent);
  padding: 0 5px;
}

/* P4.3 全屏容器：包住 .p-stage（<video>）与 .p-ctrl（自绘控制栏）。
   平时它就是 .player 里的弹性列（顶替原来 .p-stage 占的那一格），视觉与改动前一致。 */
/* P5.18（「变矮」的根因）：这里原来是 flex: 1 1 auto —— basis 是 auto，即**内容尺寸**，
   而内容里 <video> 的固有尺寸会在换流瞬间归零（emptied 时 videoWidth/videoHeight = 0）。
   flex 基准一变，剩余空间的重分配就跟着变：底部 .p-tags 拿回自己的一行（实测 27 → 42px），
   .p-stage 正好少掉这 15px（实测 550 → 534），也就是用户看到的「画面突然变矮一点、再回归」。
   改成 basis 0 之后，舞台高度只由「播放器高度 − 头部」决定（P5.24-A 删掉底部标签条后
   .p-fs-wrap 是 .p-main 里唯一的子元素，独占全部高度），与媒体元数据无关。 */
.p-fs-wrap {
  /* P5.23：控制条是它的绝对定位子元素 —— 这里必须成为包含块 */
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #000;
}

/* 全屏时浏览器只渲染被请求的那个元素：容器撑满屏幕、黑底、列布局。
   （P4.3：旧实现把全屏请求发给只包 <video> 的 .p-stage，控制栏是它的兄弟节点，一进全屏就消失。）
   P4.6：控制栏不再留在流内 —— 它改成绝对覆盖层（见下面的 .p-ctrl 规则）。
   原因：流内 + 只改 opacity 隐藏时，控制条**仍占高度**，视频区被压短、底部留一条
   与控制条等高的黑边（用户全屏截图即此）。 */
.p-fs-wrap:fullscreen,
.p-fs-wrap:-webkit-full-screen {
  /* 显式写回 fixed/inset：上面 .p-fs-wrap 的 position:relative 是作者样式，
     会盖掉 UA 给 :fullscreen 的定位，导致全屏元素只剩「内容宽度」。 */
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #000;
}

/* 全屏舞台撑满整个全屏区域：唯一个流内子元素（控制条已 absolute），无 padding / 无兄弟占位，
   视频按原比例 contain（比例不合时由 object-fit 自己 letterbox，属正常）。 */
.p-fs-wrap:fullscreen .p-stage,
.p-fs-wrap:-webkit-full-screen .p-stage {
  flex: 1 1 100%;
  height: 100%;
  min-height: 0;
}

/* P4.6 / P5.23 全屏控制条：与窗口态同一套覆盖层定位（见上面的 .p-ctrl），
   这里只补全屏专属的内边距 —— 底部留出刘海屏安全区，顶部多给 2px。
   （P5.23 之前 .p-ctrl 只在全屏是 absolute；现在两种状态都是覆盖层，规则合并到基类。） */
.p-fs-wrap:fullscreen .p-ctrl,
.p-fs-wrap:-webkit-full-screen .p-ctrl {
  padding-top: 10px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
}

/* P4.4 全屏控制条自动隐藏（判定规则见 playerExtras.ctrlCanHide）：
   只在「全屏 + 播放中 + 2.5s 无操作 + 不悬停/不拖动/无浮层」时加 .is-ctrl-hidden。
   P4.7：焦点不再是隐藏条件（点控制条按钮留下的焦点曾让它永不隐藏），改为隐藏前 blur。
   P4.6：隐藏 = opacity:0 + 整体下沉自身高度（translateY(100%)），配合绝对定位，
   既不留任何布局空间（无黑边），也不让渐变在半透明边缘透出暗影；
   pointer-events:none 让点击穿到画面上（= 暂停/播放）；鼠标指针同时隐起，
   避免画面正中挂着一个箭头。悬停控制条区域会由 mousemove 立刻把类摘掉，所以点得到。 */
.p-fs-wrap.is-ctrl-hidden {
  cursor: none;
}

.p-fs-wrap.is-ctrl-hidden .p-ctrl {
  opacity: 0;
  transform: translateY(100%);
  pointer-events: none;
}

.p-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  /* P5.18：换流瞬间 video 的固有尺寸会归零，任何「按内容撑开」的可能性都要掐掉 */
  overflow: hidden;
}

/* P5.18：<video> 与两个覆盖层走同一套定位（绝对铺满 + contain），
   于是「有没有元数据」「有没有覆盖层」都不再影响舞台尺寸，换流前后 stage rect 完全一致。 */
.p-stage video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background: #000;
}

/* P5.17 转码档防黑屏覆盖层：换流后到首帧之间把目标位置的精确帧盖在画面上。
   绝对定位铺满舞台、pointer-events:none（点画面照常暂停/播放），
   z-index 1 < .p-tap 的 2 < 控制条 5 —— 不挡「点击播放」也不挡控制条。 */
.p-stream-cover {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  pointer-events: none;
  /* P5.20：canplay 之后 180ms 淡出（.p-cover-out）再移除 —— 硬切会闪一下黑 */
  transition: opacity 180ms ease-out;
}

/* P5.20：覆盖层淡出中的状态（onCanPlay → fadeStreamCover）。只改不透明度，
   定位/尺寸/底色与 .p-stream-cover 完全一致，舞台 rect 与裁剪行为都不变。 */
.p-cover-out {
  opacity: 0;
}

/* P5.18 拖动跟随层：与 .p-stream-cover 完全同一定位（换手时画面不跳），
   z-index 1 与它同级 —— 两者不会同时出现（clearScrub → applySource 顺序保证）。 */
.p-scrub-cover {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
  pointer-events: none;
}

/* P5.19 拖动跟随层左上角的帧号：跟随帧没有原生时间码，拖到哪里只能靠这行字看出来。
   绝对定位（.p-stage 是 flex，绝对定位不参与布局 → 舞台定高不受影响）、pointer-events:none
   （不挡「点画面暂停」），z-index 2：压在跟随帧 1 之上，与「点击播放」同级（位置不重叠），
   低于控制条 5。
   半透明底 + --fg 文字 = mediaTheme 变量，亮暗主题都可读；窄屏字号在下面 @media 里再降一档。 */
.p-scrub-tc {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 2;
  max-width: calc(100% - 24px);
  padding: 2px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  color: var(--fg);
  font-size: 12.5px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
  white-space: nowrap;
  pointer-events: none;
}

.p-restart {
  position: absolute;
  left: 14px;
  bottom: 64px;
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: var(--radius);
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12.5px;
  cursor: pointer;
}

.p-restart:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.p-tap {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 2;
  padding: 13px 26px;
  border: 1px solid rgba(255, 255, 255, 0.34);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.74);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}

.p-tap:hover {
  border-color: var(--accent);
}











@media (max-width: 768px) {
  .p-head {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 8px 10px;
  }



  .p-title {
    font-size: 14px;
    white-space: normal;
  }

  /* 窄屏：三组按钮折成多行，组间竖线隐藏（折行后竖线会落在行首，反而更乱） */
  .p-actions {
    width: 100%;
    flex-wrap: wrap;
    gap: 8px;
  }

  .p-act-group {
    flex: 1 1 auto;
    justify-content: center;
  }

  .p-act-sep {
    display: none;
  }

  .p-actions .btn {
    flex: 1 1 auto;
    padding: 0 8px;
    font-size: 12px;
  }



  .p-restart {
    bottom: 56px;
    left: 10px;
  }

  /* 触屏无 hover，且 P5.14 起拖动也不出浮层：窄屏整块隐藏（.p-preview 恒带 .is-hover）。
     P5.15 起窄屏也不取帧（framePicker 的 canRequestFrame 同一判据），这里只是兜底样式 */
  .p-preview,
  .p-preview-exact,
  .p-hover-line {
    display: none;
  }

  /* 移动端控制条：按钮加大到可点尺寸，音量滑块让位给静音按钮 */
  .p-ctrl {
    padding: 6px 10px 10px;
    gap: 6px;
  }

  /* 窄屏：中组独占一行（进度条拿到整行宽度），左右两组留在第一行 ——
     375px 上也不会横向溢出，进度条轨道不会被压成一条缝。
     AB 读数在窄屏隐藏（状态仍可从设置浮层看），把宽度让给进度条。 */
  .p-grp-mid {
    order: 3;
    flex: 1 1 100%;
  }

  .p-ab-text {
    display: none;
  }

  .p-seekwrap {
    min-height: 26px;
  }

  .p-seek {
    height: 6px;
  }

  .p-ctrlline {
    gap: 6px;
  }

  .p-btn {
    min-width: 38px;
    height: 38px;
    font-size: 15px;
  }

  .p-btn-play {
    min-width: 52px;
  }

  .p-vol {
    display: none;
  }

  /* 画质行只留下拉，省出横向空间给按钮 */




  .p-fine-tip {
    display: none;
  }

  /* P5.19：常显的「位置 hh:mm:ss:ff / hh:mm:ss:ff」比原来的 mm:ss 长 60%。
     窄屏再大字号会把进度条轨道压到很窄，这里降一档（仍然 ≥11px，可读），
     同时去掉 letter-spacing 省出 2 个字符的宽度；不换行由 .p-seek-now 的 nowrap 保证。 */
  .p-seek-now {
    font-size: 11px;
    letter-spacing: 0;
  }

  /* 拖动跟随层的帧号：窄屏缩一档，位置贴近左上角，避免压住画面中心 */
  .p-scrub-tc {
    left: 8px;
    top: 8px;
    font-size: 11px;
    padding: 1px 6px;
  }
}

/* ============================ P4-B 新增控件（颜色只取 mediaTheme 变量） ============================ */

/* 标记刻度：绝对铺在 .p-seekwrap（position:relative）上，pointer-events:none 不挡 hover 与拖动。
   P4.4：左右各内缩半个 thumb，与 range 的可视轨道同源（否则两端各偏 8px） */
.p-marks {
  position: absolute;
  left: var(--thumb-r, 7px);
  right: var(--thumb-r, 7px);
  top: 50%;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  z-index: 2;
}

.p-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--accent);
  opacity: 0.85;
}

/* 区间标记：一段浅色带（半透明），两端不用额外描边，避免和 4px 轨道抢视线 */
.p-mark.is-range {
  opacity: 0.28;
  width: auto;
  margin-left: 0;
  border-radius: 2px;
}

/* 刻度提示：与 hover 卡片同样贴着进度条上方，宽度自适应文案 */
.p-marker-tip {
  position: absolute;
  bottom: calc(100% + 6px);
  transform: translateX(-50%);
  max-width: 260px;
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--fg);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  z-index: 3;
}

/* ====================== P4.1 标记轨（进度条下方独立一条） ====================== */
/* 轨道本身 pointer-events:none：不挡进度条拖动，也不挡 hover 预览；只有 .p-lane-mark 吃事件。
   P4.3：高度 / 间距 / 边宽 / 探出量改读 JS 侧的 CSS 变量（值来自 playerExtras 的 LANE_* 常量，
   见 MediaPlayer 的 laneVars），SCSS 不再另写一套数字；窄屏高度用 --lane-h-sm。
   轨道加一层淡背景 + 内描边，让它是一条看得见的「带子」，而不是飘在空白里的细线。 */
.p-marklane {
  position: relative;
  height: var(--lane-h, 12px);
  /* P4.4：左右内缩半个 thumb（var(--thumb-r)），与进度条的可视轨道同宽同起点 ——
     标记 left% 与滑块中心走同一套「比例 → 像素」换算（playerExtras.seekRatioToPx） */
  margin: var(--lane-gap, 3px) var(--thumb-r, 7px) 0;
  background: color-mix(in srgb, var(--bg-3) 88%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--line) 70%, transparent);
  border-radius: 2px;
  pointer-events: none;
  z-index: 2;
}

.p-lane-mark {
  position: absolute;
  /* P4.3：向上探出 1px（--lane-raise），让单点竖条与 4px 进度条在视觉上连成一体 */
  top: calc(-1 * var(--lane-raise, 1px));
  bottom: 0;
  padding: 0;
  border: 0;
  border-radius: 1px;
  background: var(--accent);
  /* 亮暗都可见的细描边：浅色底上勾出边界，暗色底由 html.dark 加深到 1px 深色 */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.28);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  pointer-events: auto;
}

.p-lane-mark.is-range {
  /* 区间是一条带子，不向上探出（探出会与进度条叠成一块色斑） */
  top: 0;
  box-sizing: border-box;
  min-width: 6px;
  border-left: var(--lane-edge, 3px) solid;
  border-right: var(--lane-edge, 3px) solid;
  border-radius: 1px;
}

.p-lane-mark:hover,
.p-lane-mark:focus-visible {
  outline: none;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 3px var(--accent-soft);
}

/* ================== P4.3 标记数量徽标（进度条右端 / 时间码左侧）+ 标记列表 ================== */
/* 用户两次反馈「刻度看不出来」：刻度尺寸已经加到 12px/4px，但细线本身有上限，
   于是再给一个数字入口 —— 「🚩 N」一眼看出有没有标记，点开直接跳到某条。 */






/* 列表贴着徽标向上展开（与控制条上方其它浮层同一方向），可滚动，最长 240px */






/* 小方块用标记自己的颜色（与轨道上的刻度同色，列表与刻度对得上） */










/* P4.1 视频倍速：占用原来 1×/1.5×/2× 增益按钮的位置，下拉选择 0.5×–2× */














/* P5.24-A：A / B 按钮已收进设置浮层，控制条中部只留这一行**被动读数**（不是按钮）。
   与时间码同一口径（chip + 白字）：裸 --fg-dim 直接压在近乎透明的底座上，
   最坏背衬（纯白帧）只有 1.5:1，套 chip 之后 4.8:1 以上。 */
.p-ab-text {
  flex: 0 0 auto;
  padding: 3px 8px;
  border-radius: 7px;
  background: var(--p-chip);
  color: var(--p-ink);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-shadow: var(--p-shadow);
  box-shadow: var(--p-shadow);
}

.p-ab-text.on {
  color: var(--p-ink);
  font-weight: 600;
  box-shadow: var(--p-shadow), inset 0 0 0 1px var(--accent);
}

.p-frame {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}



/* 快捷键浮层：压在播放器之上（播放器自身 z-index:100） */
.p-help {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.5);
}

.p-help-box {
  width: min(520px, 100%);
  max-height: 82vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--fg);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.p-help-h {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.p-help-list {
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.p-help-list li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 12.5px;
  line-height: 1.55;
}

.p-help-key {
  flex: 0 0 108px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg-3);
  color: var(--accent);
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.p-help-val {
  flex: 1;
  min-width: 0;
  color: var(--fg-dim);
}

.p-help-note {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--fg-dim);
}

@media (max-width: 768px) {
  /* 倍速 / 增益 / AB / 画质的窄屏尺寸由 PlayerSettings.vue 自己的 @media 负责（随组件走）。

     P4.1：窄屏标记轨保留（它是状态指示，不是浮层）；P4.3 起窄屏 12px → 8px，间距仍 3px */
  .p-marklane {
    height: var(--lane-h-sm, 8px);
    margin-top: var(--lane-gap, 3px);
  }

  /* 触屏没有 hover：刻度仍显示（它是状态不是浮层），但隐藏 hover 才有的提示卡 */
  .p-marks {
    height: 16px;
  }

  .p-help-key {
    flex-basis: 88px;
  }
}

/* ==================== P5.24-A 暗色主题：控制条令牌覆盖 ====================
   亮色是 .p-ctrl 上的默认值。暗色下底座稍微加深一档（.20，仍远低于 .30 的验收上限）、
   去掉那层白色薄雾（暗色不需要「压成浅雾」），发丝线换成亮色。 */
html.dark .p-ctrl {
  --p-scrim: rgba(0, 0, 0, 0.2);
  --p-veil: transparent;
  --p-hair: rgba(255, 255, 255, 0.1);
}

/* 暗色主题：标记在深底上靠一圈 1px 深色描边勾出边界（亮色下是同位置的浅描边） */
html.dark .p-lane-mark {
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.75);
}

html.dark .p-lane-mark:hover,
html.dark .p-lane-mark:focus-visible {
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 0 3px var(--accent-soft);
}
</style>
