<template><view /></template>
<script lang="uts">
import FrameLayout from 'android.widget.FrameLayout'
import { QwLiveKitEngine } from 'io.qiwu.livekit'

export default {
  name: 'qw-livekit',
  // 属性可先于原生视图到达，卸载后的 watcher 也不能重新绑定。
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
    /** 只向同 Room registry 提交画面意图，不接收 URL 或票据。 */
    bindView() {
      const view = this.$el
      if (this.viewReady && view != null) QwLiveKitEngine.bindVideoView(view, this.connectionId, this.participantId)
    }
  },
  NVLoad(): FrameLayout { return QwLiveKitEngine.createVideoView(this.$androidContext!) },
  NVLoaded() { this.viewReady = true; this.bindView() },
  NVBeforeUnload() {
    // tile 卸载只移除自己的 renderer，不能结束同一通话的其它画面和声音。
    const wasReady = this.viewReady
    this.viewReady = false
    const view = this.$el
    if (wasReady && view != null) QwLiveKitEngine.unbindVideoView(view)
  }
}
</script>
