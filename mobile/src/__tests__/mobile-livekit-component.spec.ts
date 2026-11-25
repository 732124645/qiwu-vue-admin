import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createServer, transformWithEsbuild, type ViteDevServer } from 'vite'
import { parse } from 'vue/compiler-sfc'
import { createRenderer, h, nextTick, reactive, type ComponentOptions } from 'vue'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

type NativeView = object
type Failure = { code: string; operation: string }
type ExamplePage = {
  shown: boolean
  generation: number
  unsubscribe: (() => void) | null
  snapshot: { connectionId: string; state: string } | null
  failure: Failure | null
  busy: boolean
  notice: string
  canRetryDisconnect?: boolean
}
type ExampleOptions = {
  onShow: (this: ExamplePage) => void
  methods: { retire: (this: ExamplePage) => void }
  computed: {
    canRetryDisconnect: (this: ExamplePage) => boolean
    closing: (this: ExamplePage) => boolean
  }
}
type Tile = {
  connectionId: string
  participantId: string
  viewReady: boolean
  $el: NativeView | null
}
type TileOptions = ComponentOptions & {
  methods: { bindView: (this: Tile) => void }
  NVLoad: (this: Tile) => NativeView
  NVLoaded: (this: Tile) => void
  NVBeforeUnload: (this: Tile) => void
}
type Host = {
  UIView: new () => NativeView
  view: NativeView
  snapshot: { connectionId: string; state: string }
  disconnectFailure: Failure | null
  pendingFail: ((error: Failure) => void) | null
  calls: {
    create: NativeView[]
    bind: [NativeView, string, string][]
    unbind: NativeView[]
    disconnect: string[]
  }
}
describe.each(['app-ios', 'app-android'])('%s native video component', (platform) => {
  const filename = fileURLToPath(
    new URL(`../uni_modules/qw-livekit/utssdk/${platform}/index.vue`, import.meta.url),
  )
  const fixture = '\0livekit-component-host'
  const pageFilename = fileURLToPath(
    new URL('../uni_modules/qw-livekit/examples/hbuilderx/pages/index.nvue', import.meta.url),
  )
  let server: ViteDevServer, component: TileOptions, host: Host
  let stopMedia: (retry?: boolean) => void
  let examplePage: ExampleOptions
  let mounted: ReturnType<typeof mountTile> | null = null

  beforeAll(async () => {
    // 转换真实组件的 UTS 脚本，只替换原生宿主；中间件模式不监听端口。
    server = await createServer({
      configFile: false,
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, watch: null, hmr: { server: createHttpServer() } },
      plugins: [
        {
          name: 'livekit-component-lifecycle',
          enforce: 'pre',
          resolveId(source) {
            if (
              [
                fixture,
                'UIKit',
                'android.widget.FrameLayout',
                'io.qiwu.livekit',
                '@/uni_modules/qw-livekit',
              ].includes(source)
            )
              return fixture
          },
          load(id) {
            if (id !== fixture) return
            return `export class UIView {}
          export default UIView;
          export const host = { UIView, view:new UIView(), snapshot:{connectionId:'',state:'idle'}, disconnectFailure:null, pendingFail:null, calls:{create:[],bind:[],unbind:[],disconnect:[]} };
          export function getSnapshot(){return host.snapshot}
          export function disconnect(options){host.calls.disconnect.push(options.connectionId);host.pendingFail=options.fail;if(host.disconnectFailure)options.fail?.(host.disconnectFailure)}
          export function onLiveKitEvent(){}
          export function connect(){}
          export function setMicrophoneEnabled(){}
          export function setCameraEnabled(){}
          export function setSpeakerOutputPreferred(){}
          export function switchCamera(){}
          export const QwLiveKitEngine = {
            createVideoView(){host.calls.create.push(host.view);return host.view},
            bindVideoView(view,connectionId,participantId){host.calls.bind.push([view,connectionId,participantId])},
            unbindVideoView(view){host.calls.unbind.push(view)}
          };`
          },
          async transform(source, id) {
            if (id !== filename && id !== pageFilename) return
            const script = parse(source, { filename }).descriptor.script
            if (!script) throw new Error('The native video component script is missing')
            const result = await transformWithEsbuild(
              id === filename && platform === 'app-ios'
                ? `import { QwLiveKitEngine } from ${JSON.stringify(fixture)};\n${script.content}`
                : script.content,
              `${filename}.ts`,
              { loader: 'ts' },
            )
            return { code: result.code, map: null }
          },
        },
      ],
    })
    component = (await server.ssrLoadModule(filename)).default as TileOptions
    host = (await server.ssrLoadModule(fixture)).host as Host
    const example = fileURLToPath(
      new URL('../uni_modules/qw-livekit/examples/hbuilderx/events.js', import.meta.url),
    )
    stopMedia = (await server.ssrLoadModule(example)).stopMedia as typeof stopMedia
    examplePage = (await server.ssrLoadModule(pageFilename)).default as ExampleOptions
  })
  afterAll(async () => {
    await server?.close()
  })
  beforeEach(() => {
    host.view = new host.UIView()
    host.calls.create.length = host.calls.bind.length = host.calls.unbind.length = 0
    host.calls.disconnect.length = 0
    host.snapshot = { connectionId: '', state: 'idle' }
    host.disconnectFailure = host.pendingFail = null
  })
  afterEach(() => {
    if (!mounted) return
    component.NVBeforeUnload.call(mounted.tile)
    mounted.app.unmount()
    mounted = null
  })

  /** Vue 负责真实 prop watch；宿主始终提供 UIView，未就绪误绑定只能由引擎调用计数暴露。 */
  function mountTile() {
    const props = reactive({ connectionId: 'connection-a', participantId: 'alice' })
    let tile!: Tile
    const renderer = createRenderer<NativeView, NativeView>({
      createElement: () => host.view,
      createText: () => new host.UIView(),
      createComment: () => new host.UIView(),
      setText() {},
      setElementText() {},
      parentNode: () => null,
      nextSibling: () => null,
      insert() {},
      remove() {},
      patchProp() {},
    })
    const native = { ...component, render: () => h('view') }
    const app = renderer.createApp({
      render: () =>
        h(native, {
          ...props,
          ref: (value: unknown) => {
            if (value !== null) tile = value as Tile
          },
        }),
    })
    app.mount(new host.UIView())
    const current = { app, props, tile }
    mounted = current
    return current
  }

  it('waits for the native view to load before binding the current connection and participant', async () => {
    const { props, tile } = mountTile()
    expect(host.calls.bind).toEqual([])
    props.connectionId = 'connection-b'
    props.participantId = 'bob'
    await nextTick()
    expect(host.calls.bind).toEqual([])
    expect(component.NVLoad.call(tile)).toBe(host.view)
    expect(host.calls.create).toEqual([host.view])
    expect(host.calls.bind).toEqual([])
    component.NVLoaded.call(tile)
    expect(host.calls.bind).toEqual([[host.view, 'connection-b', 'bob']])
  })

  it('rebinds changed props, then unbinds once and ignores watchers after native unloading', async () => {
    const { props, tile } = mountTile()
    component.NVLoad.call(tile)
    component.NVLoaded.call(tile)
    expect(host.calls.bind).toEqual([[host.view, 'connection-a', 'alice']])
    props.connectionId = 'connection-b'
    await nextTick()
    expect(host.calls.bind.at(-1)).toEqual([host.view, 'connection-b', 'alice'])
    props.participantId = 'bob'
    await nextTick()
    expect(host.calls.bind.at(-1)).toEqual([host.view, 'connection-b', 'bob'])
    expect(host.calls.bind).toHaveLength(3)
    component.NVBeforeUnload.call(tile)
    component.NVBeforeUnload.call(tile)
    expect(host.calls.unbind).toEqual([host.view])
    props.connectionId = 'connection-c'
    props.participantId = 'carol'
    await nextTick()
    expect(host.calls.bind).toHaveLength(3)
    expect(host.calls.unbind).toEqual([host.view])
  })

  it('stops the current example connection and explicitly retries unconfirmed cleanup without starting another room', () => {
    stopMedia(true)
    expect(host.calls.disconnect).toEqual([])
    host.snapshot = { connectionId: 'connection-a', state: 'connected' }
    stopMedia()
    expect(host.calls.disconnect).toEqual(['connection-a'])
    host.snapshot.state = 'disconnecting'
    stopMedia()
    expect(host.calls.disconnect).toEqual(['connection-a'])
    stopMedia(true)
    expect(host.calls.disconnect).toEqual(['connection-a', 'connection-a'])
    host.snapshot.state = 'idle'
    stopMedia(true)
    expect(host.calls.disconnect).toHaveLength(2)
  })

  it('recovers a cleanup failure missed while hidden and enables the visible retry action', () => {
    const page: ExamplePage = {
      shown: false,
      generation: 0,
      unsubscribe: null,
      snapshot: null,
      failure: null,
      busy: false,
      notice: '',
    }
    Object.defineProperty(page, 'canRetryDisconnect', {
      get: () => examplePage.computed.canRetryDisconnect.call(page),
    })
    host.snapshot = { connectionId: 'connection-a', state: 'connected' }
    try {
      examplePage.onShow.call(page)
      examplePage.methods.retire.call(page)
      host.snapshot.state = 'disconnecting'
      const failure = { code: 'SDK_ERROR', operation: 'disconnect' }
      host.pendingFail?.(failure)
      expect(page.failure).toBeNull()
      host.disconnectFailure = failure
      examplePage.onShow.call(page)
      expect(host.calls.disconnect).toEqual(['connection-a', 'connection-a'])
      expect(page.failure).toEqual(failure)
      expect(page.canRetryDisconnect).toBe(true)
      expect(examplePage.computed.closing.call(page)).toBe(false)
    } finally {
      examplePage.methods.retire.call(page)
    }
  })

  if (platform === 'app-android') {
    it('retires a missing native container without passing null to the Android bridge', () => {
      const tile: Tile = {
        connectionId: 'connection-a',
        participantId: 'alice',
        viewReady: true,
        $el: null,
      }
      component.methods.bindView.call(tile)
      expect(host.calls.bind).toEqual([])
      component.NVBeforeUnload.call(tile)
      expect(tile.viewReady).toBe(false)
      expect(host.calls.unbind).toEqual([])
    })
  }
})
