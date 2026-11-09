import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import { compileScript, parse } from 'vue/compiler-sfc'
import { effectScope, nextTick, type Ref } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { ImChange } from '@qiwu/shared/im-client'

const fixture = '\0im-pages-fixture'
const files = Object.fromEntries(['directory', 'group', 'stickers', 'room', 'message'].map((name) => [
  name, fileURLToPath(new URL(name === 'message' ? '../pages/message/index.vue' : `../pages-im/${name}/index.vue`, import.meta.url)),
]))
type Directory = { depts: { id: number; parentId: number; name: string; sortNo: number }[]; users: { id: number; displayName: string; deptId: number | null }[] }
type Page = {
  dir: Ref<Directory>; path: Ref<unknown[]>; picked: Set<number>; keyword: Ref<string>; label: Ref<string>
  detail: Ref<unknown>; members: Ref<unknown[]>; list: Ref<unknown[]>; urls: Record<number, string>
  roomId: Ref<number>; room: Ref<unknown>; entries: Ref<unknown[]>; outbox: Ref<unknown[]>
  directory: Ref<unknown>; myStickers: Ref<unknown[]>; stickerUrls: Record<number, string>; draft: Ref<string>
  rooms: Ref<unknown[]>; load: (revalidate?: boolean) => Promise<void>; reload: () => Promise<void>
  loadRooms: () => Promise<void>
}
const directory: Directory = { depts: [{ id: 1, parentId: 0, name: 'Private team', sortNo: 1 }], users: [{ id: 2, displayName: 'Private colleague', deptId: 1 }] }
const detail = { roomId: 9, kind: 'group', role: 'owner', label: 'Private group', closedAt: null }
const members = [{ userId: 2, displayName: 'Private colleague', role: 'participant', enabled: true }]
const stickers = [{ id: 4, sha256: 'private', mime: 'image/webp', width: 100, height: 100 }]
const entries = [
  { seq: 1, kind: 'text', text: 'Private message', recalledAt: null },
  { seq: 2, kind: 'image', attachment: { objectId: 4, thumbObjectId: 5 }, recalledAt: null },
]
function context() {
  return {
    cache: {
      getDirectory: vi.fn(async () => ({ data: directory })),
      getRoom: vi.fn(async () => ({ roomId: 9, detail })),
      getEntries: vi.fn(async () => entries),
      listOutbox: vi.fn(async () => [{ clientEntryId: 'pending', text: 'Private draft' }]),
      getStickers: vi.fn(async () => ({ data: stickers })),
      listRooms: vi.fn(async () => [{ roomId: 9, detail }]),
    },
    engine: { loadDirectory: async () => true, loadStickers: async () => true, setVisibleRooms: vi.fn() },
  }
}
type Ctx = ReturnType<typeof context>
type Harness = {
  imState: Ref<string>
  hooks: Record<'load' | 'show' | 'hide' | 'unload' | 'ready', ((query?: object) => Promise<void>)[]>
  ports: { get: () => Promise<unknown>; blob: () => Promise<string>; entryBlob: () => Promise<string> }
  setCurrent: (ctx: Ctx | null) => void
  emit: (change: ImChange) => void
  reset: () => void
}
let server: ViteDevServer, harness: Harness, scope: ReturnType<typeof effectScope>, ctx: Ctx
const components: Record<string, { setup: (props: object, context: object) => Page }> = {}
const title = uni.setNavigationBarTitle
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await nextTick() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeAll(async () => {
  // 编译并执行真实页面 setup；只替换宿主和网络端口，中间件模式不监听端口。
  server = await createServer({ configFile: false,
    ssr: { noExternal: ['@dcloudio/uni-app', '@qiwu/shared'] },
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, watch: null, hmr: { server: createHttpServer() } },
    plugins: [{ name: 'im-pages', enforce: 'pre',
      resolveId(source) {
        if (source === fixture || source === '@dcloudio/uni-app' || source === '@qiwu/shared' || source.startsWith('@/')) return fixture
      },
      load(id) {
        if (id !== fixture) return
        return `import { ref } from 'vue';
          export const imState=ref('ready'),imOptions=ref(null),imUnread=ref(0),imChatVisible=ref(true);
          export const imCalls=ref({calls:[],current:null,media:{state:'idle'},busy:false,error:null}),imMediaReserved=ref(false),imVoice=ref({state:'idle',roomId:null,error:null}),imVoicePlaying=ref(null),imCallCleanupBusy=ref(false);
          export const openImCallPage=()=>{},startImCall=async()=>{},cancelImVoice=async()=>{},finishImVoice=()=>{},imVoiceRoomHide=()=>{},imVoiceRoomShow=()=>{},playImVoice=async()=>{},startImVoice=async()=>{},retryImCallDisconnect=async()=>{};
          let current=null;const listeners=new Set();
          export const setCurrent=value=>current=value,imCurrent=()=>imState.value==='locked'?null:current,imStart=async()=>{},imOpenChat=()=>{};
          export const hooks={load:[],show:[],hide:[],unload:[],ready:[]};
          export const onLoad=fn=>hooks.load.push(fn),onShow=fn=>hooks.show.push(fn),onHide=fn=>hooks.hide.push(fn),onUnload=fn=>hooks.unload.push(fn),onReady=fn=>hooks.ready.push(fn);
          export const onImChange=fn=>{listeners.add(fn);return()=>listeners.delete(fn)},emit=change=>{for(const fn of listeners)fn(change)};
          export const ports={get:async()=>[],blob:async()=>'',entryBlob:async()=>''};
          export const api={get:(...args)=>ports.get(...args)},upload=async()=>{};
          export const blobUrl=(...args)=>ports.blob(...args),entryBlobUrl=(...args)=>ports.entryBlob(...args),stickerFileUrl=id=>String(id);
          export const useAuthStore=()=>({me:{user:{id:7}}}),useCountsStore=()=>({unread:0});
          export const IM_LIMITS={entriesDefault:50,stickerMax:100,textCharsMax:5000},IM_EMOJI_CATEGORIES=[],IM_STICKER_CODES=[],PAGE_SIZE_DEFAULT=20,PAGE_SIZE_MAX=100;
          export const imCodePoints=value=>[...value].length,imTextOk=()=>true;
          export const t=key=>key,tx=t,locale=()=> 'en-US',formatSize=String,formatShort=String,errorText=String;
          export const avatarTone=()=>'',initial=()=>'',builtinStickerSrc=()=>'',eventText=()=>'',kindText=()=>'',roomTitle=()=>'',userName=()=>'',previewText=()=>'';
          export const chooseUploadFiles=async()=>[],chooseImFile=async()=>null,checkPick=()=>null,guessMime=()=>'',keepPickedImage=async()=>'',outboxDiscardOnly=()=>false,safeFileName=String;
          export const pagingTheme={};
          export const reset=()=>{current=null;imState.value='ready';listeners.clear();for(const list of Object.values(hooks))list.length=0};
          export default {};`
      },
      async transform(source, id) {
        if (!Object.values(files).includes(id)) return
        const compiled = compileScript(parse(source, { filename: id }).descriptor, { id: 'im-page' })
        const result = await transformWithEsbuild(compiled.content, `${id}.ts`, { loader: 'ts' })
        return { code: result.code, map: null }
      },
    }],
  })
  harness = await server.ssrLoadModule(fixture) as Harness
  for (const [name, file] of Object.entries(files)) components[name] = (await server.ssrLoadModule(file)).default
  uni.setNavigationBarTitle = vi.fn()
})
afterAll(async () => { uni.setNavigationBarTitle = title; await server?.close() })
beforeEach(() => {
  harness.reset(); ctx = context(); harness.setCurrent(ctx); scope = effectScope()
  harness.ports.get = async () => members
  harness.ports.blob = async () => 'blob:private-sticker'
  harness.ports.entryBlob = async () => 'blob:private-image'
})
afterEach(() => scope.stop())
const open = (name: string) => scope.run(() => components[name]!.setup({}, { expose() {} }))!

it.each(['initial', 'revalidation'] as const)('the directory clears synchronously on lock and rejects a late %s snapshot', async (stage) => {
  const pending = deferred<{ data: Directory }>()
  if (stage === 'initial') ctx.cache.getDirectory.mockReturnValueOnce(pending.promise)
  else ctx.cache.getDirectory.mockResolvedValueOnce({ data: directory }).mockReturnValueOnce(pending.promise)
  const page = open('directory')
  const load = harness.hooks.load[0]!({})
  await flush()
  page.path.value = directory.depts
  page.picked.add(2); page.keyword.value = 'Private'; page.label.value = 'Private group'
  harness.imState.value = 'locked'
  expect(page.dir.value).toEqual({ depts: [], users: [] })
  expect(page.path.value).toEqual([]); expect(page.picked.size).toBe(0)
  expect(page.keyword.value).toBe(''); expect(page.label.value).toBe('')
  pending.resolve({ data: directory }); await load
  expect(page.dir.value).toEqual({ depts: [], users: [] })
})

it('the group clears loaded members and its label immediately, and a late response cannot restore them', async () => {
  const page = open('group')
  page.roomId.value = 9
  await page.load()
  expect(page.members.value).toEqual(members); expect(page.detail.value).toEqual(detail)
  const pending = deferred<unknown>()
  harness.ports.get = () => pending.promise
  const load = page.load(); await flush()
  harness.imState.value = 'locked'
  expect(page.members.value).toEqual([]); expect(page.detail.value).toBeNull()
  pending.resolve(members); await load
  expect(page.members.value).toEqual([]); expect(page.detail.value).toBeNull()
})

it('personal stickers clear on lock and ignore an old thumbnail that finishes afterwards', async () => {
  const pending = deferred<string>()
  harness.ports.blob = () => pending.promise
  const page = open('stickers')
  await page.load()
  expect(page.list.value).toEqual(stickers)
  page.urls[99] = 'blob:already-shown'
  harness.imState.value = 'locked'
  expect(page.list.value).toEqual([]); expect(page.urls).toEqual({})
  pending.resolve('blob:late-sticker'); await flush()
  expect(page.urls).toEqual({})
})

it('personal stickers cannot adopt a cached snapshot that resolves after locking', async () => {
  const page = open('stickers')
  await page.load()
  const pending = deferred<{ data: typeof stickers }>()
  ctx.cache.getStickers.mockReturnValueOnce(pending.promise)
  const load = page.load(); await flush()
  harness.imState.value = 'locked'
  expect(page.list.value).toEqual([])
  pending.resolve({ data: stickers }); await load
  expect(page.list.value).toEqual([])
})

it.each(['locked', 'cleared'] as const)('an open room removes text, drafts and images on %s, and ignores a late blob', async (reason) => {
  const pending = deferred<string>()
  harness.ports.entryBlob = () => pending.promise
  const page = open('room'); page.roomId.value = 9
  await page.reload()
  expect(page.entries.value).toEqual(entries)
  page.draft.value = 'Private unsent text'; page.urls[99] = 'blob:shown'
  page.stickerUrls[99] = 'blob:shown-sticker'
  if (reason === 'locked') harness.imState.value = 'locked'
  else { harness.setCurrent(null); harness.emit({ type: 'cleared' }) }
  expect(page.entries.value).toEqual([]); expect(page.outbox.value).toEqual([])
  expect(page.room.value).toBeUndefined(); expect(page.directory.value).toBeUndefined()
  expect(page.draft.value).toBe(''); expect(page.urls).toEqual({}); expect(page.stickerUrls).toEqual({})
  pending.resolve('blob:late-image'); await flush()
  expect(page.urls).toEqual({})
})

it('an interrupted room cache read cannot restore the text after locking', async () => {
  const page = open('room'); page.roomId.value = 9
  await page.reload()
  const pending = deferred<typeof entries>()
  ctx.cache.getEntries.mockReturnValueOnce(pending.promise)
  const reload = page.reload(); await flush()
  harness.imState.value = 'locked'
  expect(page.entries.value).toEqual([])
  pending.resolve(entries); await reload
  expect(page.entries.value).toEqual([])
})

it('the message tab clears both room previews and its directory before late cache reads finish', async () => {
  const page = open('message')
  await page.loadRooms()
  expect(page.rooms.value).toHaveLength(1); expect(page.directory.value).toEqual(directory)
  const pending = deferred<{ data: Directory }>()
  ctx.cache.getDirectory.mockReturnValueOnce(pending.promise)
  const load = page.loadRooms(); await flush()
  harness.imState.value = 'locked'
  expect(page.rooms.value).toEqual([]); expect(page.directory.value).toBeUndefined()
  pending.resolve({ data: directory }); await load
  expect(page.rooms.value).toEqual([]); expect(page.directory.value).toBeUndefined()
})
