# Qw LiveKit

面向普通 uni-app Vue3 的 LiveKit 原生桥和视频组件。RTC、媒体采集、编码、发布订阅与重连由官方 SDK 完成，插件负责原生能力桥接、连接生命周期和视图绑定。

当前为 **双平台开发原型**。iOS 使用官方 Swift SDK SPM exact 2.19.0。已完成原生源码、真实 SDK，以及普通 uni-app 的 UTS API 与兼容视频组件的完整编译/链接；核验链路为 `isX: false`、`DCUniBase` 宿主，没有混用 uni-app x 的 `UniappRuntime`。29 项 XCTest 在 iOS Simulator 上全部通过，另有九项覆盖 iOS/Android 组件及示例停止与前后台恢复逻辑的辅助测试通过；宿主 App 的安装签名、真实 LiveKit 服务及真机音视频仍未验收。Android 已在独立本地验证工程中用完整 LiveKit SDK 依赖编译原生桥和测试 APK，普通 uni-app 的 UTS 接口/组件也经官方 Kotlin 编译器与 D8 生成真实 JAR/DEX；AOSP Android 35 ARM64 模拟器上的 30 项 instrumentation 测试全部通过。正式模块现已登记 Android 原生依赖配置并接入员工 App；分发许可仍单独保留审查。上述 iOS 结果不表示双端完成，也不承诺 HBuilderX GUI 按钮无需适配即可成功。

## API

```js
import {
  connect,
  disconnect,
  getSnapshot,
  onLiveKitEvent,
  offLiveKitEvent,
  setMicrophoneEnabled,
  setCameraEnabled,
  switchCamera,
  setSpeakerOutputPreferred,
} from '@/uni_modules/qw-livekit'
```

完整类型见 [index.d.ts](./index.d.ts)。一次操作的 `success(snapshot)` / `fail({ code, operation })` 只完成一次；API 不返回 Promise。`requestMicrophonePermission(callback)` 仅申请系统麦克风权限，不连接 Room、不启动采集，业务端仍须在回调后核对当前身份与操作代次。

| 接口                                 | 参数与用途                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `connect(options)`                   | `{ url, token, microphone?, camera?, success?, fail? }`。url/token 由接入方业务服务器在运行时返回，媒体开关默认 false |
| `disconnect(options)`                | `{ connectionId, success?, fail? }`。取消 connecting 或释放当前 Room；旧编号不能停止后来新建的连接                    |
| `setMicrophoneEnabled(options)`      | `{ connectionId, enabled, success?, fail? }`，明确启停麦克风                                                          |
| `setCameraEnabled(options)`          | 同上，明确启停摄像头                                                                                                  |
| `switchCamera(options)`              | `{ connectionId, success?, fail? }`，摄像头已开启时切换镜头                                                           |
| `setSpeakerOutputPreferred(options)` | `{ connectionId, enabled, success?, fail? }`，设置内置扬声器偏好；不保证覆盖有线或蓝牙设备                            |
| `getSnapshot()`                      | 同步读取媒体快照，不含票据或原生 SDK 对象                                                                             |
| `onLiveKitEvent(callback)`           | App 级只注册一次；事件为 `state/participants/tracks/audio-route/error`，携带 snapshot 与受控 error                    |
| `offLiveKitEvent()`                  | 取消 App 自己的原生事件回调；页面退出只取消宿主的普通 JS 订阅，不移除其他页面共用的 App 回调                          |

快照包含 `connectionId`、`state`、`localIdentity`、`microphone`、`camera`、`speakerPreferred` 和 `participants`。状态为 `idle/connecting/connected/reconnecting/disconnecting`。一次新连接使用新编号；重复 connect 返回 `BUSY`，释放完成回到 idle 后才能再次连接。状态来自官方 SDK 与原生桥，不能把请求已发送或拿到票据显示为已接通。

业务服务器负责登录身份、租户、邀请、成员与 sid 资格、短期 scoped grant 及远端房间结束。插件不签发 JWT，不接收服务器 API secret，也不保存通话历史。url/token 不进入业务日志、事件、页面路由、缓存、页面 data 或组件 props；官方 SDK 内部信令握手可能携带临时票据查询串，媒体代理必须关闭该路径 URL 日志（见 [部署](../../../../docs/livekit.md)）；不通过 WebView 传票据。客户端断开不等于服务器已经吊销旧 JWT，业务接入仍须处理自己的 leave/end 与服务端清理。

## 视频组件

使用同模块的 `<qw-livekit>` 兼容组件，放在专用 `.nvue` 页面，不要求把现有业务 `.vue` 页面改成 uni-app x。

```vue
<qw-livekit
  :connection-id="snapshot.connectionId"
  :participant-id="participant.identity"
  style="width: 300px; height: 220px"
/>
```

`participantId` 是快照中的 identity，不是姓名。API 和组件共享同一 native Room，组件不收 url/token。组件卸载只解绑自己的摄像头 renderer，整次连接断开才停止本地 tracks、移除监听并释放 Room。列表 key 应含 connectionId 与 identity，避免复用旧连接画面。

## 独立 HBuilderX 示例

[examples/hbuilderx](./examples/hbuilderx) 是开发者接入源，包含最小 App/main/pages/manifest、一页 `.nvue`、App 级事件分发、空的业务票据接入点和两份语言 JSON。它不注册到业务应用页面，也不提供员工票据输入框；当前没有预置服务器或票据。插件原生编译/链接已有验证，但示例宿主的安装签名、真实服务与媒体仍未验收，不能据此视为安装即通话的成品。

1. 在 HBuilderX 创建独立的普通 uni-app Vue3 工程，将 `examples/hbuilderx` 中的源复制到该工程根目录。
2. 将本模块复制到示例工程的 `uni_modules/qw-livekit`，保留 `package.json`、`index.d.ts`、`utssdk` 等模块源；不要把 `.build`、本地产物或示例目录再次嵌套复制。示例通过 `@/uni_modules/qw-livekit` 使用同模块 API，视频组件由 easycom 识别。
3. 在示例工程自己的 manifest 填写应用标识和本地签名配置，核对麦克风与摄像头用途说明。示例 manifest 只提供 iOS 用途说明和 nvue 基本配置，不代表 Android 已就绪。
4. 将 `connection.js` 的 `requestConnection()` 接到自己的已认证业务服务，由该服务校验资格后返回新签发的 `{ url, token }`。函数初始返回 null；没有服务时只显示未配置，不伪造连接。
5. 使用真实 UTS 原生编译/链接并在受支持的 iOS 宿主运行。先连接，确认媒体开关都关闭，再由按钮或开关明确启用麦克风/摄像头、切换镜头及设置扬声器偏好。

接入点只负责获取运行时票据，不应把 API secret、长期 token 或测试账号写入源码。`requestConnection()` 返回值只在发起操作的函数局部使用，示例不保存、不显示、不记录它，也不从页面路由读取它。语言标签来自 `locales/zh-CN.json` 与 `locales/en-US.json`，按宿主 locale 选择。

示例 App 在启动时只注册一次原生事件，页面每次显示时订阅普通 JS 分发。Android 清理失败时保留连接，显示受控错误与“重试断开”；同一编号可重试，原生拒绝并行释放。页面或 App 隐藏时也会再次请求清理。页面 `onHide/onUnload` 退役 generation、清状态并退订，停止连接/采集；App 的 `onHide` 也停止媒体。申请票据的迟到响应不再连接，操作迟到成功仅尝试关闭它自己的连接编号，不能关闭后来连接。回到前台不会自动重连或开麦，需要重新点击连接。

## Android 源码进度

`utssdk/app-android` 已有 Kotlin 单 Room 协调器、官方 SDK 薄适配、UTS API、FrameLayout 视频组件和必要权限声明。权限复用 DCloud 接口，等待授权期间的取消与迟到结果仍受当前连接约束。API 和组件与 iOS 使用同一份公开类型，未引入 renderjs 或另嵌 WebView。

本地验证使用 JDK 17、Gradle 8.9、AGP 8.7.2、API 35 和完整 LiveKit 2.30.0 依赖图，原生 Kotlin 与测试 APK 编译成功；30 项 instrumentation 在 AOSP Android 35 ARM64 上实跑通过，零失败、零跳过。普通 uni-app UTS 接口和组件另外使用匹配 HBuilderX 5.26 的真实 classic 运行库、官方 Kotlin 2.2 编译器/UTS plugin 与 D8，实际产出 JAR 和 DEX；未用平台替身或省略视频组件。

真实编译发现组件 `$el` 可空，已在源中显式检查容器后再进入非空 native API，并补辅助用例。这些验证仍不等于完整宿主 App 的运行或真实媒体互通。正式模块的 `config.json` 已固定完整 SDK 和桥所需协程依赖，供私有 App 集成编译。候选 SDK 的传递分发许可未闭合；依赖登记及私有本地工程编译不代表已放行打包分发。

## 当前 iOS 受控错误

以下 code 来自当前 `utssdk/app-ios/hybrid.swift`，错误只包含 code/operation，不附原始 SDK 异常、url 或 token。它们描述桥的受控结果，Android 使用相同受控错误边界，具体平台支持见类型与源码。

| code               | 当前含义                                                          |
| ------------------ | ----------------------------------------------------------------- |
| `BUSY`             | Room 尚未释放、正在断开，或另一媒体操作尚未完成                   |
| `INVALID_URL`      | URL 不符合桥的地址约束；生产使用 WSS，本机开发才允许 loopback WS  |
| `INVALID_TOKEN`    | 空 token、超过长度限制或含控制字符                                |
| `STALE_CONNECTION` | 连接编号不匹配当前 Room，或已没有可操作的 Room                    |
| `NOT_CONNECTED`    | 媒体操作需要 connected，但当前仍在连接或重连等状态                |
| `NO_CAMERA`        | 摄像头尚未开启就请求切换镜头                                      |
| `CANCELLED`        | 正在执行的操作被断开/退役取消                                     |
| `DISCONNECTED`     | SDK 报告断开，桥开始清理                                          |
| `SDK_ERROR`        | SDK 连接、设备、权限或媒体操作失败；当前不向 JS 暴露细分 SDK 异常 |

接入方对 `SDK_ERROR` 检查系统权限、业务资格和连接状态，不要求用户粘贴票据或打印 SDK 原始异常。操作失败不应把 UI 开关强行改成成功，以后续快照为准。

## 编译与验证

当前验证使用 HBuilderX 5.26 与 Xcode 27.1，插件 `utssdk/app-ios/config.json` 和原生 `Package.swift` 均实际设置最低 **iOS 15**。官方 Swift SDK 本身声明的 iOS 13 最低版本不能替代这一宿主验证基线；较低系统版本尚未核验。Swift tools 和精确依赖以模块 manifest 为准。

| 验证层                              | 当前结果                                                              |
| ----------------------------------- | --------------------------------------------------------------------- |
| 原生源码与官方 LiveKit SDK          | 编译/链接完成                                                         |
| 普通 uni-app UTS API + 兼容视频组件 | 完整原生编译/链接完成；`isX: false`、`DCUniBase`，使用下述诊断适配    |
| Swift/XCTest 原生行为测试           | iOS 26.2 Simulator 上 29 项通过，零失败、零跳过                       |
| Vue 组件与示例生命周期辅助测试      | 双平台组件/容器五项、示例停止/前台恢复四项通过；不代替原生验证        |
| 宿主 App 安装与签名                 | 未验收                                                                |
| 真实 SFU、iPhone 媒体与硬件         | 未验收                                                                |
| Android                             | 本地原生/UTS 编译及 30 项原生测试通过；宿主、真实媒体和分发许可未验收 |

依赖变化后需要重新做原生编译/链接；普通 `uni build -p app`、TypeScript 或 H5 构建不能替代。编译通过也不表示已连接媒体服务器或取得摄像头/麦克风权限。

### HBuilderX / Xcode 兼容限制

这组工具链的普通 uni-app 构建存在已知适配点：

- 遇到旧 `-target` 调用的目标解析/索引问题时，使用同一目标对应的 `-scheme` 进行诊断构建，保持目标、架构与 deployment target 一致。
- 旧链接参数 `-ld64` 在此组合下会被 Clang 当作查找 `libd64`。本次验证仅在本机私有诊断 driver 中过滤该旧参数，没有改动官方 SDK 或 HBuilderX 安装目录。
- 该诊断 driver、DCloud 私有 driver 及原生二进制不随仓库分发。已经取得的源码/SDK/UTS 链接证据，不代表原 GUI 按钮开箱即可构建、签名或安装；接入者需要核对自己的工具链与宿主集成。

### SwiftPM 解析与 Simulator 测试

在本仓库根目录运行 `pnpm mobile:native:ios`。入口使用临时源码副本、独立 DerivedData/SourcePackages 和自建 iPhone Simulator，执行后只删除本次设备；日志与真实 xcresult 留在输出的临时证据目录。它要求非空通过、零失败、零跳过，不会把 CLI 返回 0 当作测试通过，也不会执行 UTS 宿主构建。此入口需要 macOS、Xcode 与可用的 iOS 15+ Simulator runtime。

依赖已解析时可用 `QW_NATIVE_IOS_PACKAGES=/absolute/path/to/SourcePackages pnpm mobile:native:ios` 复用本地 SwiftPM 缓存，避免重复下载大体积框架；仍只使用 `Package.resolved` 的固定版本，不接受缓存中的任意新版本。缓存是编译工具管理的依赖目录，源副本、DerivedData 和本次设备仍独立。

在本模块目录排查公共依赖解析时，使用匿名 SwiftPM，不读取用户 Keychain 或 netrc，也不提供业务服务端 secret：

```sh
swift package --disable-keychain --disable-netrc resolve
```

这一命令只解析依赖，不执行 UTS 宿主编译或测试。原生包的 Simulator 测试可使用标准 Xcode 工具；先从设备列表中选择自己的模拟器 UDID，并将示例占位值替换为该 UDID：

```sh
xcrun simctl list devices available
qw_simulator_id='YOUR_SIMULATOR_UDID'
qw_native_build_dir="$(mktemp -d)"

xcodebuild test \
  -scheme QwLiveKitNative \
  -destination "platform=iOS Simulator,id=$qw_simulator_id" \
  -derivedDataPath "$qw_native_build_dir/DerivedData" \
  -clonedSourcePackagesDirPath "$qw_native_build_dir/SourcePackages" \
  -packageAuthorizationProvider netrc \
  CODE_SIGNING_ALLOWED=NO
```

DerivedData 与 SourcePackages 位于接入者自己创建的临时目录；保留精确依赖及锁文件，不复用其他工程的私有路径。`netrc` 授权提供器用于避免 Keychain 交互，公共 SDK 无需账号；使用不含 SDK 访问凭据的 netrc 配置。免签名只针对 Simulator 测试，不表示已完成宿主 App 的设备签名、安装或发行准备。

原生可控 SDK 端口测试用于证明状态、取消、代次隔离和视图释放，不证明摄像头、扬声器、弱网或 TURN。还需实际 LiveKit 服务与 iPhone 核对权限拒绝、麦克风/摄像头开关、镜头切换、扬声器/耳机、系统中断、退出/切后台停止和视频视图重建；当前没有真实媒体接通的验收结果。

不提供后台来电、离线推送、CallKit、后台持续采集、屏幕共享或录制。小程序和普通 Web 页面不调用此原生桥；Web 应使用官方 JavaScript SDK。

## 许可证与 Android 状态

本插件自己的桥接代码使用 MIT。LiveKit SDK、WebRTC 和其他原生依赖各自保留原许可证及声明；主 SDK 的 Apache-2.0 不代表传递依赖已经完成审计。

本次锁定的 iOS SPM 解析项为 LiveKit Swift 2.19.0、LiveKit FFI 0.13.1（Apache-2.0）及 LiveKitWebRTC 150.7871.04（BSD）。上游许可与声明位于 `utssdk/app-ios/Resources/QwLiveKitThirdPartyNotices.txt`，分发宿主 App 时须保留并核对资源打包结果；原生模块链接成功不能替代最终 App 的资源与许可核对。[DCloud 资源目录说明](https://uniapp.dcloud.net.cn/plugin/uts-plugin.html#resources)将此目录定义为应用 Main Bundle 资源，尚未在本原型中完成宿主安装包检查。

Android 候选 SDK 2.30.0 的 `android-jain-sip-ri` 分发许可澄清见 [官方议题](https://github.com/livekit/client-sdk-android/issues/1048)。在版本特定的授权、声明及 Android 构建链明确前，不把 Android 记作可分发或原生验收通过，不直接删除必需依赖或自动退回旧媒体引擎。Android 已用完整候选依赖完成私有本地编译与原生测试；这些结果不构成分发许可结论。两平台的宿主安装与真实媒体仍未验收，不能据此宣称双端成品完成。
