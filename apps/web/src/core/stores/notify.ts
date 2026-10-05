import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { BulletinFeedItem, MyInboxItemVo, RealtimePayloads } from '@qiwu/shared'
import { bulletinFeedApi } from '@/api/platform/messaging/bulletin-feed'
import { inboxMineApi } from '@/api/platform/messaging/inbox-mine'

/**
 * Header bell state (`notify`; see docs/design-notes.md#layering): the bulletin feed and the latest inbox messages with their
 * unread counts. Per feed, an answer to a request started before a newer load, push or read never
 * overwrites the newer state; `reset()` (sign-in / sign-out) drops everything, also answers still pending
 * for the ended session.
 */
export const useNotifyStore = defineStore('notify', () => {
  const bulletins = shallowRef<BulletinFeedItem[]>([])
  const bulletinUnread = ref(0)
  const inbox = shallowRef<MyInboxItemVo[]>([])
  const inboxUnread = ref(0)
  const unread = computed(() => bulletinUnread.value + inboxUnread.value)
  let bulletinSeq = 0
  let inboxSeq = 0
  let epoch = 0

  async function loadBulletins() {
    const mine = ++bulletinSeq
    try {
      const feed = await bulletinFeedApi.feed()
      if (mine !== bulletinSeq) return
      bulletins.value = feed.items
      bulletinUnread.value = feed.unread
    } catch {
      // silent bell feed: focus, push or polling retries
    }
  }

  async function loadInbox() {
    const mine = ++inboxSeq
    try {
      const [page, count] = await Promise.all([
        inboxMineApi.page({ page: 1, pageSize: 8, sort: '-createdAt,-id' }, { silent: true }),
        inboxMineApi.unread({ silent: true }),
      ])
      if (mine !== inboxSeq) return
      inbox.value = page.items
      inboxUnread.value = count.unread
    } catch {
      // silent bell feed: focus, push or polling retries
    }
  }

  const load = () => Promise.all([loadBulletins(), loadInbox()])

  async function readBulletin(id: number) {
    const session = epoch
    const mine = ++bulletinSeq
    const count = await bulletinFeedApi.read(id)
    if (session !== epoch) return
    if (mine !== bulletinSeq) return void loadBulletins()
    bulletinUnread.value = count.unread
    bulletins.value = bulletins.value.map((item) =>
      item.id === id ? { ...item, read: true } : item,
    )
  }

  async function readAllBulletins() {
    const session = epoch
    const mine = ++bulletinSeq
    const count = await bulletinFeedApi.readAll()
    if (session !== epoch) return
    if (mine !== bulletinSeq) return void loadBulletins()
    bulletinUnread.value = count.unread
    bulletins.value = bulletins.value.map((item) => ({ ...item, read: true }))
  }

  async function readInbox(id: number) {
    const session = epoch
    const mine = ++inboxSeq
    const count = await inboxMineApi.read(id)
    if (session !== epoch) return
    if (mine !== inboxSeq) return void loadInbox()
    inboxUnread.value = count.unread
    inbox.value = inbox.value.map((item) =>
      item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
    )
  }

  async function readAllInbox() {
    const session = epoch
    const mine = ++inboxSeq
    const count = await inboxMineApi.readAll()
    if (session !== epoch) return
    if (mine !== inboxSeq) return void loadInbox()
    inboxUnread.value = count.unread
    const now = new Date().toISOString()
    inbox.value = inbox.value.map((item) => ({ ...item, readAt: item.readAt ?? now }))
  }

  function onInboxNew(_payload: RealtimePayloads['notify:new']) {
    ++inboxSeq
    inboxUnread.value++
    void loadInbox()
  }

  function reset() {
    ++epoch
    ++bulletinSeq
    ++inboxSeq
    bulletins.value = []
    bulletinUnread.value = 0
    inbox.value = []
    inboxUnread.value = 0
  }

  return {
    bulletins,
    bulletinUnread,
    inbox,
    inboxUnread,
    unread,
    loadBulletins,
    loadInbox,
    load,
    readBulletin,
    readAllBulletins,
    readInbox,
    readAllInbox,
    onInboxNew,
    reset,
  }
})
