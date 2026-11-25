<template>
  <scroll-view class="qw-call-page" scroll-y :style="{ backgroundColor: tokens.canvas }">
    <view class="qw-call-content">
      <text class="qw-call-title" :style="{ color: tokens.text }">{{
        view?.call ? t('imMedia.call.' + view.call.mode) : t('imMedia.call.title')
      }}</text>
      <text v-if="!view" class="qw-call-hint" :style="{ color: tokens.text2 }">{{
        t('imMedia.call.loading')
      }}</text>
      <text v-else-if="view.closed" class="qw-call-hint" :style="{ color: tokens.text2 }">{{
        t('imMedia.call.closed')
      }}</text>
      <template v-else>
        <text v-if="view.call" class="qw-call-hint" :style="{ color: tokens.text2 }">{{
          t('imMedia.call.businessState', { state: t('imMedia.call.state.' + view.call.state) })
        }}</text>
        <text class="qw-call-hint" :style="{ color: tokens.text2 }">{{
          t('imMedia.call.mediaState', { state: t('imMedia.call.media.' + view.media.state) })
        }}</text>
        <text v-if="failure" class="qw-call-hint" role="alert" :style="{ color: tokens.danger }">{{
          failure
        }}</text>
        <text v-if="!view.writer" class="qw-call-hint" :style="{ color: tokens.text2 }">{{
          t('imMedia.call.notLeader')
        }}</text>
        <text v-if="view.otherCallActive" class="qw-call-hint" :style="{ color: tokens.danger }">{{
          t('imMedia.call.otherCall')
        }}</text>
        <view
          v-if="view.media.state === 'disconnecting'"
          class="qw-call-card"
          :style="{ backgroundColor: tokens.surface, borderRadius: tokens.radius }"
        >
          <text class="qw-call-hint" :style="{ color: tokens.text }">{{
            t('imMedia.call.cleanup')
          }}</text>
          <button
            class="qw-im-media-button"
            role="button"
            :tabindex="view.controlBusy ? -1 : 0"
            :aria-disabled="view.controlBusy"
            @keydown="activateImMediaButton($event, view.controlBusy, () => act('retryDisconnect'))"
            :loading="view.controlBusy"
            :disabled="view.controlBusy"
            @click="act('retryDisconnect')"
          >
            {{ t('imMedia.call.retryDisconnect') }}
          </button>
        </view>
        <view
          v-for="person in participants"
          :key="view.media.connectionId + ':' + person.identity"
          class="qw-call-card"
          :style="{ backgroundColor: tokens.surface, borderRadius: tokens.radius }"
        >
          <text class="qw-call-name" :style="{ color: tokens.text }">{{ person.name }}</text>
          <text class="qw-call-hint" :style="{ color: tokens.text2 }">{{
            t('imMedia.call.participantDevices', {
              microphone: t('imMedia.call.' + (person.microphone ? 'on' : 'off')),
              camera: t('imMedia.call.' + (person.camera ? 'on' : 'off')),
            })
          }}</text>
          <ImBrowserVideo
            v-if="person.camera"
            class="qw-call-video"
            :connection-id="view.media.connectionId"
            :participant-id="person.identity"
          />
        </view>
        <view
          v-for="member in view.call?.members || []"
          :key="member.userId"
          class="qw-call-member"
        >
          <text :style="{ color: tokens.text }">{{ member.displayName }}</text>
          <text :style="{ color: tokens.text2 }">{{
            t('imMedia.call.member.' + member.state)
          }}</text>
        </view>
        <view
          v-if="connected"
          class="qw-call-card"
          :style="{ backgroundColor: tokens.surface, borderRadius: tokens.radius }"
        >
          <view class="qw-call-control">
            <text :style="{ color: tokens.text }">{{ t('imMedia.call.microphone') }}</text>
            <switch
              :checked="view.media.microphone"
              :disabled="busy"
              @change="change('microphone', $event)"
            />
          </view>
          <view v-if="view.call?.mode === 'video'" class="qw-call-control">
            <text :style="{ color: tokens.text }">{{ t('imMedia.call.camera') }}</text>
            <switch
              :checked="view.media.camera"
              :disabled="busy"
              @change="change('camera', $event)"
            />
          </view>
          <button
            class="qw-im-media-button"
            role="button"
            :tabindex="busy ? -1 : 0"
            :aria-disabled="busy"
            @keydown="activateImMediaButton($event, busy, () => act('audio'))"
            v-if="view.audioBlocked"
            :disabled="busy"
            :loading="view.controlBusy"
            @click="act('audio')"
          >
            {{ t('imMedia.call.enableAudio') }}
          </button>
          <button
            class="qw-im-media-button"
            role="button"
            :tabindex="busy ? -1 : 0"
            :aria-disabled="busy"
            @keydown="activateImMediaButton($event, busy, () => act('switchCamera'))"
            v-if="view.media.camera"
            :disabled="busy"
            :loading="view.controlBusy"
            @click="act('switchCamera')"
          >
            {{ t('imMedia.call.switchCamera') }}
          </button>
        </view>
        <button
          class="qw-im-media-button qw-call-primary"
          role="button"
          :tabindex="busy || view.otherCallActive || view.media.state !== 'idle' ? -1 : 0"
          :aria-disabled="busy || view.otherCallActive || view.media.state !== 'idle'"
          @keydown="
            activateImMediaButton(
              $event,
              busy || view.otherCallActive || view.media.state !== 'idle',
              () => act('accept'),
            )
          "
          v-if="view.call?.canAccept && !connected"
          :style="{ backgroundColor: tokens.brand, color: tokens.onBrand }"
          :disabled="busy || view.otherCallActive || view.media.state !== 'idle'"
          :loading="view.controlBusy || view.busy"
          @click="act('accept')"
        >
          {{ t('imMedia.call.accept') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="busy ? -1 : 0"
          :aria-disabled="busy"
          @keydown="activateImMediaButton($event, busy, () => act('decline'))"
          v-if="view.call?.canDecline && !connected"
          :disabled="busy"
          :loading="view.controlBusy"
          @click="act('decline')"
        >
          {{ t('imMedia.call.decline') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="busy || view.otherCallActive ? -1 : 0"
          :aria-disabled="busy || view.otherCallActive"
          @keydown="activateImMediaButton($event, busy || view.otherCallActive, () => act('join'))"
          v-if="view.call?.canJoin && !view.call.canAccept && view.media.state === 'idle'"
          :disabled="busy || view.otherCallActive"
          :loading="view.controlBusy || view.busy"
          @click="act('join')"
        >
          {{ t('imMedia.call.join') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="view.controlBusy ? -1 : 0"
          :aria-disabled="view.controlBusy"
          @keydown="activateImMediaButton($event, view.controlBusy, () => act('leave'))"
          v-if="view.call?.canLeave && view.media.state !== 'idle' && !view.otherCallActive"
          :disabled="view.controlBusy"
          :loading="view.controlBusy"
          @click="act('leave')"
        >
          {{ t('imMedia.call.leave') }}
        </button>
        <button
          class="qw-im-media-button"
          role="button"
          :tabindex="view.controlBusy ? -1 : 0"
          :aria-disabled="view.controlBusy"
          @keydown="activateImMediaButton($event, view.controlBusy, () => act('end'))"
          v-if="view.call?.canEnd && !view.otherCallActive && view.media.state !== 'disconnecting'"
          :style="{ color: tokens.danger }"
          :disabled="view.controlBusy"
          :loading="view.controlBusy"
          @click="act('end')"
        >
          {{ t('imMedia.call.end') }}
        </button>
      </template>
      <button
        class="qw-im-media-button"
        role="button"
        :tabindex="!!view?.controlBusy ? -1 : 0"
        :aria-disabled="!!view?.controlBusy"
        @keydown="activateImMediaButton($event, !!view?.controlBusy, close)"
        :disabled="view?.controlBusy"
        @click="close"
      >
        {{ t('imMedia.call.close') }}
      </button>
    </view>
  </scroll-view>
</template>
<script setup lang="ts">
import { activateImMediaButton } from '../../core/im/media-button'
import ImBrowserVideo from '@/core/components/im/ImBrowserVideo.vue'
import { useImCallPage } from '@/core/im/call-page'
const { t, view, busy, connected, participants, tokens, failure, act, change, close } =
  useImCallPage()
</script>
<style>
.qw-call-page {
  flex: 1;
  height: calc(100vh - var(--window-top, 0px));
}
.qw-call-content {
  padding: 32rpx;
  padding-bottom: 64rpx;
}
.qw-call-title {
  font-size: 40rpx;
  font-weight: 600;
  margin-bottom: 20rpx;
}
.qw-call-hint {
  display: flex;
  font-size: 26rpx;
  margin-bottom: 16rpx;
  line-height: 40rpx;
}
.qw-call-card {
  margin-top: 20rpx;
  margin-bottom: 20rpx;
  padding: 24rpx;
}
.qw-call-name {
  font-size: 30rpx;
  font-weight: 500;
  margin-bottom: 12rpx;
}
.qw-call-member,
.qw-call-control {
  flex-direction: row;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 16rpx;
  padding-bottom: 16rpx;
}
.qw-call-video {
  width: 622rpx;
  height: 360rpx;
}
.qw-call-primary {
  margin-top: 24rpx;
}

.qw-im-media-button:focus-visible {
  outline: 2px solid var(--qw-brand);
  outline-offset: 2px;
}
</style>
