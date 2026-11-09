<template><view /></template>
<script lang="uts">
import { UIView } from 'UIKit'

export default {
  name: 'qw-livekit',
  // 属性可能先于 View 到达；卸载后的迟到属性回调也不能重新绑定。
  data() { return { viewReady: false } },
  props: {
    connectionId: { type: String, default: '' },
    participantId: { type: String, default: '' }
  },
  watch: {
    connectionId: { handler(value: string, oldValue: string) { this.bindView() }, immediate: false },
    participantId: { handler(value: string, oldValue: string) { this.bindView() }, immediate: false }
  },
  methods: {
    /** 原生引擎自行跟随 track registry，只绑定当前连接的 camera。 */
    bindView() {
      if (this.viewReady) QwLiveKitEngine.bindVideoView(this.$el, this.connectionId, this.participantId)
    }
  },
  NVLoad(): UIView { return QwLiveKitEngine.createVideoView() },
  NVLoaded() { this.viewReady = true; this.bindView() },
  NVBeforeUnload() {
    // tile 卸载只解除 renderer，不结束同一个 Room 的其它画面或声音。
    if (this.viewReady) QwLiveKitEngine.unbindVideoView(this.$el)
    this.viewReady = false
  }
}
</script>
