# 移动端（uni-app）开发说明

> 员工用移动端：微信小程序、安卓、iOS（H5 只用于开发调试）。

## 概览

- 代码在仓库根的 `mobile/`，**不在主 pnpm workspace 里**：它有自己的 `package.json`、`pnpm-workspace.yaml`（`allowBuilds`、`minimumReleaseAge`）与 `pnpm-lock.yaml`。根目录的 `pnpm i`、`pnpm -r …` 与根锁定文件完全不含它。
- 工程由 DCloud 官方模板 `uni-preset-vue#vite-ts` 起步，只保留微信小程序、App（安卓/iOS）与 H5 三个平台，并做了 4 处修正：`package.json` 不写 `"type": "module"`（否则 `uni is not a function`）、`@vue/tsconfig` 用 0.9.x、tsconfig 不写 `baseUrl`、`vite.config.ts` 里 `esbuild.tsconfigRaw.compilerOptions.target = "es2022"`。
- 版本随 uni-app 锁死、全部写精确版本，不跟随主工程：`@dcloudio/*` `3.0.0-5020620260917001`（对应 HBuilderX 5.26）、`vite` 5.2.8、`vue` / `@vue/runtime-core` 3.4.21、`@dcloudio/types` 3.4.31、`pinia` 2.2.4、`vue-i18n` 9.1.9（只供类型：构建时 uni 换成它内置的 9.1.9 运行时）、TypeScript 6.0 + `vue-tsc` 3、`vitest` 3.2（vitest 4 要求 vite 6）。
- 共享代码：`vite.config.ts` 把 `@qiwu/shared` 别名到 `../packages/shared/src`（不走 workspace 链接），把 `zod` 别名到 `mobile/node_modules/zod`（app 与 shared 只打包一份 zod）。`src/main.ts` 第一个 import 是 `src/core/jitless.ts`（`z.config({ jitless: true })`，微信小程序禁止 `new Function`）；shared 自己也会在建 schema 之前设 jitless，两者作用于同一个 zod 配置。`mobile/` 的 zod 版本须与根 `pnpm-workspace.yaml` catalog 中的一致。
- shared 必须能在小程序里跑：只 import `zod` 与自己的文件，tsconfig 保持 `"types": []`（arch 检查 `shared-portable`）。
- 主工程（apps、packages、scripts、根配置）不得引用 `mobile/`，下文"只要 PC"一节列出的白名单行除外（arch 检查 `mobile-refs`）。

## 安装与开发

```bash
pnpm mobile:install            # = pnpm -C mobile i --frozen-lockfile（首次需联网）
pnpm -C mobile dev:h5          # H5 调试，/api 代理到 API_PROXY_TARGET（默认 http://127.0.0.1:3000，即 pnpm dev 的后端）
pnpm -C mobile dev:mp-weixin   # 用微信开发者工具导入 mobile/dist/dev/mp-weixin
pnpm -C mobile dev:app         # 用 HBuilderX 导入 mobile/dist/dev/app，运行到手机或模拟器
```

## 基础层（`mobile/src/core`）

- **请求**（`request.ts`）：`api.get/post/put/delete`、`upload`（`uni.uploadFile` 走后端上传，字段 `file`）。基址默认 `/api`（H5 走代理）；小程序与 App 构建时设 `VITE_API_BASE=https://<域名>/api`。每个请求带 `X-Client-Id: mobile`、`Accept-Language`、`X-Timezone`；access 令牌只在内存，refresh 令牌存 uni 存储（`qw.auth.rt`），401 时单飞刷新（`POST /auth/refresh {refreshToken}`，应答同登录：`accessToken` + 轮换后的 `refreshToken`）并重放；刷新被拒 → 清会话、`reLaunch` 到 `/pages/login/index`。403/409/422/429/5xx 与网络错误弹 toast，`silent` 调用方自己处理；例外是 403 `A1004`（须先改密码，服务端此时只放行 `/auth/me`、`/auth/menus`、改密与退出）：不弹 toast，`reLaunch` 到改密页 `/pages-sys/password/index`。
- **登录态与权限**（`stores/auth.ts`）：`hasPerm()`（任一即可，`*` 全通过）与 `<QwPerm perm="…">`（小程序不支持自定义指令）；只控制显示，权限以服务端为准。`/auth/me` 带 `mustChangePassword` 或 `passwordExpired`（初始密码、密码过期）时 `passwordChangeDue` 为真：`fetchMe()` 之后与每次 tab 页显示时都转到改密页；改密页此时显示原因和"退出登录"，改完重新取 `/auth/me` 再进入工作台。
- **实时推送**（`core/realtime.ts`；细节见 `docs/realtime.md` 的"移动端（uni-app）"一节）：登录后连服务端的 Socket.IO 网关（只走 websocket），握手带内存里的 access 令牌和当前语言；用的是官方 `socket.io-client`，加自写的 `uni.connectSocket` 传输类，H5、小程序、App 走同一套代码。收到 `wf:task`、`notify:new` → 重新拉取待办数和未读数（`stores/counts.ts`）；`session:kicked` → 回登录页，并提示"你已被管理员强制下线，请重新登录"。应用回到前台（`App.vue` 的 `onShow`）和 tab 页显示时连接，并补拉一次计数；进入后台（`onHide`）、登录、登出时断开。socket 连不上时（小程序没配 socket 合法域名、网络受限等），tab 页每 60 秒轮询一次，所以角标最迟 60 秒内刷新。
- **国际化**（`i18n.ts`）：一律用 `t(key, params)` / `tx()` / `issueText(schema, issue)`，不要用 vue-i18n 的 `t`/`$t`（小程序上不插值，完整版还会 `new Function`）。文案放 `src/locales/{zh-CN,en-US}/*.json`，`validation.*`/`field.*`/`seed.*` 直接来自 shared；`setLocale()` 同时切换 wot-ui 与 uni 内置界面，并存入 `qw.locale`。
- **主题**（`App.vue`、`core/theme.ts`）：`page, .wd-root-portal` 上定义"远洋"亮色与暗色令牌（同名令牌与 web `tokens.css` 的亮/暗值一致，移动端独有的见 visual-system §12.1，`mobile-theme.spec.ts` 校验），`--wot-*` 只指向 `--qw-*`；不要用 `<wd-config-provider>`（它的 `.wot-theme-light` 会覆盖映射）。默认跟随系统；App 与 H5 在「我的」→「外观」三选一（跟随系统 / 浅色 / 深色，`setThemePref()`，存 `qw.theme`，即时生效、重启后保持），小程序只跟随系统（该菜单项用条件编译 `#ifndef MP-WEIXIN` 去掉）。暗色在 H5 由 `<html>` 上的 `qw-dark` 类生效，App 与小程序走 `prefers-color-scheme`（App 用 `plus.nativeUI.setUIStyle` 连原生栏一起切）；原生导航栏、tab 栏与页面底色写在 `src/theme.json`，`pages.json` 用 `@` 变量引用，`manifest.json` 的 App 与小程序开 `darkmode`；H5 不开（uni-h5 开了之后 `uni.hideTabBar` 失效），构建时取 `theme.json` 的浅色值，由 `core/theme.ts` 读系统主题，深色时 `App.vue` 的样式按 `qw-dark` 类把原生导航栏改成深色（类一设上就生效，直接用地址打开的页面在它自己的代码加载前也不会先露出浅色栏）。App 的 `manifest.json` 写 `safearea.bottom.offset: none`：页面铺到底部 Home 指示条下（与 H5、小程序一致，底部栏和弹层用 `env(safe-area-inset-bottom)` 留白）；uni 对有 tabBar 的应用默认 `auto`，页面停在指示条上方，下面露出按浅色 tab 栏取色、不随主题的白带。App 上 uni 报告的主题（`getAppBaseInfo().theme`、`osTheme`、`plus.navigator.getUIStyle()`）都是被「外观」强制后的应用样式，系统主题改问 iOS 屏幕的 `traitCollection`（`plus.ios`；`setUIStyle` 只在 iOS 生效）；uni 在主题变化时会把所有页面的状态栏字色改成跟主题走，所以海军蓝页面（登录、微信绑定、tab 页）显示时与主题变化后都由 `whiteStatusBar()` 重设白字（`NAVY_PAGES` 与 `pages.json` 对照校验）。主题变化时 uni 还会按 `pages.json` 重建每个页面的原生导航栏：页面运行时设的标题（`uni.setNavigationBarTitle`）由 `core/theme.ts` 的拦截器同时写进该页的路由元数据，重建后保留；重建不带返回箭头颜色（iOS 上箭头随之变白，浅色栏上看不见但仍可点），所以 `pages.json` 的 `globalStyle["app-plus"]` 用 `theme.json` 的 `navBack` 指定。注意：HBuilder 基座（io.dcloud.HBuilder）的 Info.plist 写死 `UIUserInterfaceStyle = Light`，在基座上跟随系统看不到深色，要在模拟器上验证可临时改成 `Automatic`。z-paging 的主题属性统一用 `pagingTheme`（深色用它的 white 一套）。公共组件 `QwPageHeader`（tab 页海军蓝头部）、`QwBrandMark`、`QwEmpty`、`QwIcon`（自绘线性图标，CSS 遮罩 + `currentColor`）与 `App.vue` 的公共类（`.qw-sheet` `.qw-sec` `.qw-row` `.qw-av` `.qw-tile` `.qw-tag` `.qw-badge` `.qw-btn` 等）供各页使用；各页不写裸色值，只用 `--qw-*`。
- **静态资源与图标/启动图**：插画（夜色梧桐 `art/`）、空状态（`empty/`）、tab 图标（`tab/`，常态与选中各按亮/暗一份，暗色文件名带 `-dark`）与白色标志（`brand/`）是 `src/static/` 下本项目自绘的 SVG，导出时只含对应主题的令牌色（`mobile-theme.spec.ts` 校验），每个 ≤ 4 KB，在主包里；换图时保持文件名、只用令牌色。App 图标（品牌蓝）与启动图是 PNG，放在 `mobile/unpackage/res/{icons,splash}/`（不放 `src/static`，否则会打进小程序主包），由 `manifest.json` 的 `app-plus.distribute.icons` / `splashscreen` 引用；改图标时用 HBuilderX 的 manifest 可视化编辑器从 1024×1024 原图重新生成各尺寸，云打包后在真机上核对（[发布清单](#发布清单) 第 4 节）。
- **登录页**（`pages/login`，启动页）：账号密码与短信两种登录，都以 `clientId: 'mobile'` + `keepSignedIn: true` 建 `mobile` 会话（refresh 令牌在应答体里）；已有会话直接进入应用。外观：`LoginShell.vue` 画海军蓝背景与夜色梧桐插画（中文时左侧竖排题款「良禽择木而栖」，英文不显示）、标志与标语，下方是贴底的表单底板（深色下为表面色），两种登录方式用标题式选项卡切换；键盘弹起（`uni.onKeyboardHeightChange`，H5 用 `visualViewport`）或窗口高度 < 700 时换成紧凑头部，`onUnload` 解除监听；微信绑定页 `pages-sys/wx-bind` 用它的紧凑头部。验证码按 `captcha.mode`（公开参数）弹 `<QwCaptcha>`：滑块用 `go-captcha-uni`（MIT，只引 `components/slide`，300×220 与服务端滑块数据一致），图形模式取 `format=png`；服务端跨 IP 要求验证码（A1021）时再弹一次。"记住用户名"只存用户名（`qw.login.username`）。页脚左侧是语言切换（`.qw-login__lang`，底部弹层选语言），右侧是版本、隐私政策与用户协议（两者暂时打开"关于"页，正式页面的内容由部署方提供，见[发布清单](#发布清单) 第 3 节）。表单校验直接用 shared 的 zod schema（`fieldErrors()`），字段名来自 `field.auth.*`。
- **主框架**（`pages.json`）：主包只有登录页与四个 tab 页（`pages/{home,approval,message,mine}`），其余按领域分包：`pages-wf`（审批）、`pages-biz`（业务）、`pages-sys`（系统、消息与个人）。`tabBar.list` 仍列出四个 tab 页（`uni.switchTab` 保留页面），但原生 tabBar 不支持运行时文案，由每个 tab 页底部的 `<QwTabBar current="…">`（wot-ui `wd-tabbar`，图标为 `static/tab/` 的亮/暗 SVG）代替；登录页与四个 tab 页是自定义导航（`navigationStyle: custom`），tab 页顶部为 `QwPageHeader`（海军蓝 + 夜色插画），显示时隐藏原生的；它还负责无会话时回登录页、设置导航栏标题（`uni.setNavigationBarTitle`），以及在 tab 页显示时（切换 tab、从子页面返回、回到前台）与显示期间每 60 秒刷新待办数与未读数（`stores/counts.ts`，工作台与 tab 角标共用；socket 已连上时由实时推送刷新，见上"实时推送"）。
- **工作台**（`pages/home`）：头部问候与部门/角色；三格计数——待办、审批中（我发起且仍在进行的流程：`stores/counts.ts` 取 `GET /api/wf/instances/mine?state=running&pageSize=1` 的 `total`，与待办数、未读数一起每分钟刷新，`mobile-counts.spec.ts` 覆盖）、未读消息（点击进入对应 tab）；常用功能（`SHORTCUTS`，彩色图标块，带 `perm` 的按 `hasPerm()` 显示，进入各自分包的页面：发起审批、请假（新建请假单，需 `biz.leave.create`）、公告）；"待我审批"取待办前 3 条（`GET /api/wf/tasks/todo?pageSize=3`），"全部 ›"进入审批 tab。
- **消息**（`pages/message` + `pages-sys/{inbox,bulletin}`）：头部摘要为未读条数；tab 页顶部是公告入口（最新一条标题 + 未读角标），下面是我的站内信（每条前为类别图标块：业务为公文包、系统为铃铛，未读带红点），用 `z-paging`（MIT，npm 包缺 license 字段，按版本在 `mobile/license-exceptions.json` 登记为 MIT）分页：下拉刷新、滚到底加载下一页；tab 页再次显示时（从详情返回、切 tab、回到前台）一次请求刷新已加载的各页。点开一条进入 `pages-sys/inbox/detail`（类别图标块 + 纯文本，保留换行），未读的随即标记已读并用应答里的未读数更新角标；"全部已读"读完其余。公告列表 `pages-sys/bulletin/index` 即服务端 feed（最新 5 条，与 web 铃铛一致），详情用 `rich-text` 显示保存时已清洗的 HTML（图片限宽），打开即已读，也可全部已读。时间统一 `core/format.ts` 的 `formatTime()`（本地时区 `YYYY-MM-DD HH:mm`，不依赖 Intl）。
- **我的**（`pages/mine` + `pages-sys/{profile,password,about}`）：资料头部（头像、姓名、用户名、部门与角色标签，点击进个人资料）、带图标的菜单（个人资料、修改密码；语言、外观（App/H5）、关于）、卡片式"退出登录"、底部"栖梧 · 版本"行；"关于"页顶部为标志、字标与版本。子页（`pages-sys/*`、`pages-biz/*`）统一用卡片分组与 `QwEmpty`。
- **审批**（`pages/approval`，逻辑在 `core/approvals.ts`，`mobile-approvals.spec.ts` 覆盖）：头部摘要（"n 项待你处理"），下面的分段筛选（`.qw-seg`，替换 `wd-tabs`）切换四个列表——待办（`GET /api/wf/tasks/todo`）、已办（`/wf/tasks/done`）、我发起的（`/wf/instances/mine`）、抄送我的（`/wf/ccs/mine`），全部复用 审批中心接口（只要求登录、只返回本人数据，移动端不新增接口），用 `z-paging` 分页（下拉刷新、滚到底加载下一页）；切换列表即重新加载，上一个列表迟到的应答丢弃；tab 页再次显示时一次请求刷新已加载的各页。每行：发起人头像字；标题为模型名（`tx()`）；第二行「发起人 发起 · 节点名」（节点名经 `tx()`；抄送为「发起人 发起 · 发送人」，流程节点的抄送为「流程抄送」）；右侧为 `formatShort()` 短时间（待办为到达时间、已办为处理时间、我发起的为发起时间、抄送为抄送时间）。服务端拼的实例标题（`模型名-发起人-发起日期`）移动端不显示（`core/approvals.ts` 的行带 `modelName`、`initiator`、`initiatorId`，接口未改）。任务与流程状态按字典 `wf.task_state` / `wf.instance_state` 显示为 `.qw-tag` 状态标签（已办的第二个状态即流程所处状态，以文字显示）。列表为空时显示 `QwEmpty`，待办为空时多一个"查看已办"按钮。待办列表的应答总数同时写入 `stores/counts.ts` 的待办数：工作台、tab 角标与"待办"标签上的角标共用它，不必等每分钟的轮询。点一行进入 `pages-wf/detail/index?id=<实例 ID>`（审批详情，见下条）；未读的抄送先 `POST /api/wf/ccs/:id/read` 标记已读再进入。v1 不做 web 端的状态与已读筛选。
- **审批详情**（`pages-wf/detail`）：复用 `GET /api/wf/instances/:id`（只有发起人、办理人、抄送人与有 `wf.instance.view` 且数据范围覆盖的人能看，其余一律 404，页面用 `QwEmpty` 显示服务端的 404 文案）。依次显示：头卡（模型图标、标题、流程状态（字典 `wf.instance_state`）、"发起人 发起于 时间"），轮到我时下方一条"待你处理 · 节点名"提示；表单卡——注册表配了 `summary` 的显示单据摘要（请假：类型、起止、天数、事由，右上"查看完整表单 ›"），没配的保留"表单"一行；审批记录为自绘时间线（`.qw-tl`，替换 `wd-steps`：每条为头像字、操作人（空为"系统"）、动作（字典 `wf.action`）、节点名（`tx()`）、时间、目标（人名，退回为目标节点名）与意见，我待办的节点画在最后）。
  - **移动端视图注册表**（`core/views.ts` 的 `MOBILE_FORMS`，只放页面路径：审批 tab 在主包，小程序主包不能引用分包代码）：每个 `custom` 模型一条，由它在 web 端的 `create_route`（如 `/biz/leave/new`）与 `view_component`（如 `biz/leave/view`）对应到移动端 `pages-biz` 里的查看页（`view`）与新建/修改页（`form`），可选 `icon`（详情头卡与发起页的图标）与 `summary`（详情表单卡的摘要：取单据的接口、标题键、字段及其字典或时间格式）。注册了的，"表单"一行可点，打开 `<查看页>?id=<业务键>&readonly=1`；没注册的与还没有业务单据的显示"请在电脑端查看"；`dynamic` 模型的表单见下文"动态表单"。新增业务单据的移动端页面时，在这里加一条并在 `pages.json` 的 `pages-biz` 分包登记页面。小程序不支持动态组件、跨分包引用组件，所以是跳转到业务页面而不是嵌入。
  - **请假查看页**（`pages-biz/leave/view?id=<请假单 ID>`）：`GET /api/biz/leaves/:id`（只要求登录，访问规则同实例，无关用户 404），显示状态（字典 `biz.leave_state`）、类型（`biz.leave_kind`）、天数、起止时间、事由与创建时间；不带 `readonly=1` 时（本人从别处打开）多一行"审批详情"进入其实例。
  - **决定与转派**（通过、驳回、退回、转办、委派；`pages-wf/detail/DecideSheet.vue`，逻辑在 `core/approvals.ts`，`mobile-approvals.spec.ts` 与 `mobile-wf-decide.spec.ts` 覆盖）：详情的 `myTasks` 里有我的待办审批任务（`review`，取最早一条）时，页面底部固定一条操作栏："通过""驳回"直接可点，"退回""转办""委派"（及下面的其余动作）在"更多"（`wd-action-sheet`）里；委派或加签来的子任务在决定类动作里只能"通过"。每个动作打开一个底部弹层（标题"动作 · 节点名"）：退回从 `GET /api/wf/tasks/:id/back-targets` 选一个目标（已经过的节点，最后是"发起人"）；转办、委派用 `QwUserPicker`（`source="wf"`）选一个人，委派多一行说明；都可填意见（最多 1000 字），节点 `commentRequired` 时通过和驳回的意见必填。校验直接用 `@qiwu/shared` 的请求体 schema（`wfSendBackBody` / `wfHandOverBody` / `wfCommentBody`，必填意见用 `wfRemarkBody`），不通过就不发请求，提示显示在字段下方，之后随输入更新。提交调用 `POST /api/wf/tasks/:id/{approve,reject,send-back,transfer,delegate}`，请求期间按钮 loading 且禁用；400 与 404（任务已不是我的）显示在弹层里，409/422 由请求层 toast。成功后提示"已办理"并重新加载详情（操作栏随之消失或换成下一条任务）。
  - **其余动作**（加签、减签、抄送、评论、撤回、撤销、催办；同上，`mobile-wf-extra.spec.ts` 覆盖）：`core/approvals.ts` 的 `detailActions` 按顺序列出我能做的动作——我最早一条待办审批任务的通过、驳回、退回、转办、委派、加签、抄送、评论（子任务只有通过、抄送、评论），然后是减签（详情 `signs`，我发起、还没处理的加签，只取同一父任务的）、撤回（`withdrawable`，我最近一次通过，下一步还没人动）、催办（`canUrge`）、重新提交（被退回给发起人：我的 `begin` 任务，见"发起"）、撤销（`canCancel`）。有待办审批任务时操作栏放"通过""驳回"，否则放最后两个（发起人即"撤销""催办"，被退回时"撤销""重新提交"），其余在"更多"。加签选前加签/后加签（`WF_SIGN_KINDS`）并多选人员，后加签等于我现在通过，节点 `commentRequired` 时意见必填；减签勾选要撤掉的加签任务；抄送多选人员，意见一栏即"抄送说明"（`reason`）；评论意见必填；撤回、撤销各有一行说明，意见可填。校验同样用共享 schema（`wfAddSignBody` / `wfRemoveSignBody` / `wfCcBody` / `wfRemarkBody` / `wfCommentBody`，需要必填意见时再加 `wfRemarkBody` 的规则），接口为 `POST /api/wf/tasks/:id/{add-sign,remove-sign,cc,comment,withdraw}` 与 `POST /api/wf/instances/:id/cancel`。催办不开弹层，直接 `POST /api/wf/instances/:id/urge`（`silent`），请求期间按钮 loading 且禁用；成功提示"已催办"并重新加载，429（每小时一次）提示"每小时只能催办一次，请稍后再试"，其他错误 toast 服务端文案。
- **发起**（`pages-wf/start` 与 `pages-biz/leave/index`，逻辑在 `core/approvals.ts`，`mobile-approvals.spec.ts` 与 `mobile-wf-start.spec.ts` 覆盖；验收流程也在后者）：发起页复用 `GET /api/wf/startable-models`（只要求登录），按字典 `wf.category` 的顺序分组（字典里没有的分类排最后），模型名与说明经 `tx()`。点 `custom` 模型：注册表按 `create_route` 找到移动端新建页就进入，否则提示"该流程请在电脑端发起"；点 `dynamic` 模型：有表单的打开 `pages-wf/start/form` 填写（见下条"动态表单"），没有表单的在底部弹层按 `GET /api/wf/models/:key/start-info` 列出发起人自选的节点，每个节点一个多选 `QwUserPicker`（`source="wf"`），都至少选一人才发请求（提示同服务端 `validation.wf.picks_missing`），`POST /api/wf/instances {modelKey, initiatorPicks}` 后进入该实例详情。
  - **请假新建/修改页**（`pages-biz/leave/index`）：请假类型（`QwDictSelect`，`biz.leave_kind`）、开始/结束时间（`wd-datetime-picker`，按本地时间选，提交为 ISO 时间）、天数（`wd-input-number`，步长 0.5、一位小数）、事由；规则直接用 shared 的 `leaveCreate`，不通过不发请求。新建：`POST /api/biz/leaves`（保存并发起流程，一个请求），成功后替换为该实例的详情页。被退回给发起人时，有修改权限（注册表的 `modify`，请假为 `biz.leave.modify`）的，详情操作栏的"重新提交"进入 `?id=<请假单>&task=<begin 任务>`：表单带出原值，按钮"重新提交"先 `PUT /api/biz/leaves/:id` 再 `POST /api/wf/tasks/:task/resubmit`，然后返回详情（详情页每次显示都重新加载）。没有修改权限的（同 web：不改单据直接重新提交）、没有移动端页面的 `custom` 模型与 `dynamic` 模型的"重新提交"走操作弹层（意见可填）。提交按钮请求期间 loading 且禁用。
- **动态表单**（`pages-wf/form/`，`mobile-process-form.spec.ts` 与 `mobile-wf-dynamic.spec.ts` 覆盖）：`dynamic` 模型的流程表单在手机上由自写渲染器显示（没有引入 form-create：小程序不支持动态组件）。有表单的模型在发起页打开 `pages-wf/start/form` 填写；没有表单的仍在原来的弹层里选人。详情页按节点 `access` 显示：`hide` 字段不下发也不显示，`edit` 字段可以修改，通过或重新提交时只发 `edit` 字段。值的格式、必填与形状校验、计算组件都复用 `@qiwu/shared`（客户端只做预检，结果以服务端重算为准）。以下组合在手机上只读，并提示"请在电脑端填写"：datePicker 的 `dates`、`week`、`years`、`months`；`valueFormat` 含 `YYYY MM DD HH mm ss Z` 以外的记号；多选级联；自带的 upload 桩。附件只显示文件名，不能在手机上打开或下载。`validate` 里 `required` 以外的规则（`pattern`、`email`、`len`…）手机端不校验，服务端也不查。
- **选择组件**（`core/components`，逻辑在 `core/pickers.ts`，`mobile-pickers.spec.ts` 覆盖）：都是一行 `wd-cell`（`label` 为标题，值或占位文字在右），点开底部弹层；弹层用 `root-portal`，放在别的弹层里也能正常显示。
  - `<QwUserPicker v-model="users" [multiple] [source]>`：`v-model` 为选中的用户（`id`、`displayName`、`deptName`），提交时取 `id`。`source="wf"`（默认，审批用：转办、委派、加签、抄送、发起人自选）走只要求登录的 `GET /api/wf/users/options`（全部启用用户，按姓名搜索，没有部门树）；`source="iam"` 走 `GET /api/iam/users/options`（调用者数据范围内），上方是部门树，逐级点进部门（面包屑返回），列表为该部门及其下级的用户。关键字停止输入 300 ms 后搜索，过期应答丢弃。单选点一下即选中并关闭；多选逐个勾选，按钮"确定（n）"提交（一个不选即清空）。
  - `<QwDeptPicker v-model="deptId">`：`GET /api/iam/depts/tree`（数据范围内）上的 `wd-cascader`，任一级可选（点部门展开下级，"确认"取最后点的一级；再点一次取消，确认空值即清为 `null`）；树里没有的部门显示其 id。
  - `<QwDictSelect v-model="kind" code="biz.leave_kind" [multiple]>`：字典条目上的 `wd-select-picker`，值为条目编码（未选为 `null`），标签按 `labelI18n[当前语言]` → 种子 key → 编码；字典在一次运行内只取一次（v1 不按 `version` 失效，改字典后重启应用生效）。
  - `<QwUpload v-model="files" [biz-tag] [limit] [max-size]>`：`v-model` 为已存对象（`FsObjectVo[]`，提交时取 `id`）；先在本地检查个数与大小，再逐个经 `uni.uploadFile` 走后端 `POST /api/storage/objects`（`bizTag` 在文件之前，默认私有 `attachment`；公开标签只收图片，因此只让选图片），失败由请求层提示、列表不变；移除只从列表去掉。选文件：微信小程序从聊天记录选（`chooseMessageFile`），H5 用浏览器文件框，App 只能选图片（无原生插件时 uni 没有通用文件选择）。v1 只显示文件名与大小，不打开文件。

## 生成器的移动端页面

- 在代码生成的编辑页「生成」标签里打开「移动端页面」（`cg_table.options.withMobile`，按表开启，默认关闭）。预览、下载、`pnpm gen render|write` 会多出这些文件：
  - `mobile/src/api/<home>.ts`
  - `mobile/src/pages-biz/<home>/{index,detail,form}.vue`（只读模块没有 form）
  - `mobile/src/locales/{zh-CN,en-US}/<domain>.<biz>.json`
- 这些页面依赖手写的 `mobile/src/core/crud.ts` 和 `mobile/src/locales/*/crud.json`。
- 生成器不改已有文件：注册行会打印 `pages.json` 里 `pages-biz` 分包的条目，需要手工粘贴；入口（例如工作台快捷方式）由项目自己决定。
- 列表页：z-paging，只有一个关键字搜索框。树：逐层下钻，上级只读，移动节点在电脑端做。主子表：每行一张卡片，可增删行。
- 没有生成的部分（标明了限制）：密钥列、其余列表筛选、详情里的部门名和用户名（显示 id）、子表单元格级的错误提示。
- 校验用共享的 `<biz>Create`；服务端会再校验一次。
- G0 示例：`demo_book`、`demo_topic`、`demo_invoice` 的 9 个页面已登记在 `pages.json`，但没有入口，只能通过 URL 打开。H5 e2e 是 `mobile/e2e/mobile-codegen.spec.ts`。`build:mp-weixin` 和 mp-size 会一起编译、检查这些页面。正式发布前从 `pages.json` 去掉它们的登记（见[发布清单](#发布清单) 第 1 节）。

## 构建

| 命令                          | 产物                          | 说明                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm mobile:build:h5`        | `mobile/dist/build/h5`        | 只用于调试与 e2e                                                                                                                                                                                                                                                                                                                                                                                     |
| `pnpm mobile:build:mp-weixin` | `mobile/dist/build/mp-weixin` | 构建后检查包体积（`scripts/mp-size.mjs`）：主包与每个分包 ≤ 2 MB、总计 ≤ 30 MB；各包只能引用主包与本包的代码和组件（不能引用别的分包，否则该包不能独立加载）；不满足即失败。另外检查产物里有没有小程序无法运行的代码：只要出现 `Function("return this")`、`require("ws")` 或 `xmlhttprequest-ssl`，构建就失败（engine.io-client 的全局对象已由 `vite.config.ts` 里的插件换成 `core/eio-globals.ts`） |
| `pnpm mobile:build:app`       | `mobile/dist/build/app`       | App 资源，交给 HBuilderX 打包                                                                                                                                                                                                                                                                                                                                                                        |

### HBuilderX 打包（安卓 / iOS）

1. 安装与 `@dcloudio/*` 版本对齐的 HBuilderX（当前 5.26），登录 DCloud 账号。
2. `mobile/src/manifest.json` 填好 `appid`（DCloud 应用标识）、名称、版本与图标。
3. `pnpm mobile:build:app`（`uni build` 之后把 `mobile/unpackage/res` 的图标与启动图复制到 `dist/build/app/unpackage/res`：`manifest.json` 按这个相对路径引用，而 `uni build` 只带 `src/static`；`mobile-manifest.spec.ts` 校验该步骤），在 HBuilderX 中导入 `mobile/dist/build/app`，"发行 → 原生 App-云打包"（或本地打包）。签名证书、隐私政策与商店上架见[发布清单](#发布清单) 第 3 节。

### 微信小程序登录

小程序启动时先用 `uni.login` 静默登录（`POST /api/auth/wx-mp/login`）：已绑定账号直接进入工作台；未绑定则进入绑定页（`pages-sys/wx-bind`），用账号密码或短信验证码登录一次即完成绑定。H5 与 App 不受影响（条件编译 `MP-WEIXIN`）。启用步骤：

1. `apps/server/.env.local` 写 `WX_MP_APPID=wx…` 与 `WX_MP_SECRET=…`（AppSecret 只放这里，不进任何提交的文件；`.env` 里也不要留空键，否则会遮住 `.env.local`）。
2. 超级管理员在参数管理把 `auth.wx_mp.enabled` 改为 `true`（默认关闭；关闭或缺少 AppID/密钥时所有微信登录接口返回 404）。
3. 微信公众平台 → 开发管理 → 服务器域名，把 API 域名加入 request 合法域名，再把 `wss://<API 域名>` 加入 socket 合法域名（实时推送用；不配也能用，只是角标退回 60 秒轮询）；`mobile/src/manifest.json` 的 `mp-weixin.appid` 填同一个 AppID。

用户可在 Web 个人中心"账号绑定"页查看和解绑（开关关闭时也可以；解绑会结束该用户其他的移动端会话，当前会话保留）。本人改密码、短信重置密码或管理员重置密码时，该用户的微信绑定一并解除，需重新绑定。服务端经 `core/net` 出站守卫调用 code2Session，`session_key` 不保存、不下发。

### 微信订阅消息

有新待办时，用微信一次性订阅消息提醒审批人（默认关闭）。服务端在站内信投递成功后发送，与站内信的实时推送（`notify:new`）同一套机制：不建表、不重试、服务端不记订阅次数。每次订阅的额度由微信保存；用户没有额度时微信返回 43101，服务端直接跳过。站内信行仍是消息记录，微信调用失败不影响它。

触发条件，全部满足才会发送：

- 参数 `notify.wx_subscribe.enabled` 为 `true`；
- 已配置 `WX_MP_APPID` / `WX_MP_SECRET`（与微信登录共用）；
- 这条通知的编码在 `notify.wx_subscribe.templates` 里配了非空的模板 id；
- 收件人有当前 AppID 下、未解绑的微信绑定。

满足后调用一次 `subscribeMessage.send`。access_token 用 `cgi-bin/stable_token` 获取（AppSecret 只放在 POST 请求体里），缓存在 Redis `qw:wxmp:token:{appid}`，比微信给的有效期提前 5 分钟过期；如果被微信判定失效（40001/42001/40014），重新取一次再发一次。日志只记 errcode；AppSecret、access_token 和微信的应答都不进日志，也不进任何接口应答。

小程序端：「我的」页出现「新待办微信提醒」，只在小程序上、已绑定微信、开关打开且已配置模板时显示（`GET /api/iam/profile/socials/wx-mp/subscribe` 返回可申请的模板 id）。用户每点一次，就申请一次订阅，对应一条以后的新待办提醒。用户在微信弹窗里勾了「总是保持以上选择」之后，再点不会弹窗。H5 和 App 不显示这个入口。

启用步骤：

1. 微信公众平台 → 订阅消息：选一个公共模板（例如「待办事项提醒」），记下模板 ID 和各字段的键（如 `thing1`、`time2`）。
2. 确认 `apps/server/.env.local` 里已有 `WX_MP_APPID` / `WX_MP_SECRET`。如果小程序后台开启了 API IP 白名单，要把服务器的出口 IP 加进去。
3. 在参数管理修改 `notify.wx_subscribe.templates`（JSON，按通知编码配置）。种子预置的是：
   `{"wf.task.assigned":{"id":"","page":"pages-wf/detail/index?id={instanceId}","data":{"thing1":"{title}","time2":"{time}"}}}`
   - `id` 填模板 ID，空串表示不发。
   - `data` 的键改成所选模板的真实字段键。
   - 可用占位符：`{title}`（站内信标题）、`{time}`（通知时间，按收件人时区，`YYYY-MM-DD HH:mm`），以及通知的原始参数（只限字符串和数字，如 `{instanceId}`、`{initiator}`）。
   - 服务端按字段类型截断：thing 20、name 10、phrase 5、character_string/letter 32、symbol 5 个字符。字段键配错时，微信返回 47003，服务端记 warn。
   - 可选 `state`：`developer`、`trial` 或 `formal`（默认 `formal`），控制点开消息时打开哪个版本的小程序。
   - 其他通知编码（如 `wf.instance.sent_back`）按同样格式追加即可。
4. 把 `notify.wx_subscribe.enabled` 改为 `true`。

开关关闭时，系统行为与未接入时完全一样：不请求微信、不显示入口。待办被转办或重新指派时也会再提醒一次（`wf.task.assigned` 会再次发出）。真实的微信发送要等有了真实 AppID、AppSecret 和模板之后，在[发布清单](#发布清单) 第 4 节的真机核对里人工核对；自动化测试（`wx-subscribe.e2e`）用的是假网关，只验证请求形状、开关和各种跳过规则。

### App 版本更新

- **管理页**：系统管理 → App 版本（权限 `settings.appVersion.*`）。每行是一个「平台 + 版本号」，同一平台同一版本只能有一行未删除的记录。
  - 平台：android / ios。
  - 包类型：
    - `wgt`：资源热更新包，App 内下载、安装后自动重启；
    - `full`：整包。安卓填安装包或应用市场链接，iOS 填 App Store 链接，App 用系统浏览器或商店打开。
  - 下载地址：只接受 https。
  - 最低原生版本：只对 wgt 有效，空表示不限。
  - 强制更新：打开后弹窗没有"稍后"。
  - 更新说明：作为弹窗正文，空则用默认文字。
  - 发布状态：关掉就等于撤回。
- **开关**：参数 `app.update.enabled`，默认 `false`。关闭时 `GET /api/settings/app-versions/latest` 一律返回 `null`，App 不提示，对系统没有任何影响。
- **App 端行为**：只有 App 端检查。H5 不检查；小程序由微信在冷启动时自行更新。App 启动时把平台、资源版本（`plus.runtime.getProperty`，即当前 wgt 的版本）和原生版本（`plus.runtime.version`）发给上面的接口。
  - 这是公开接口，按来源 IP 每分钟限 60 次；超限或任何失败都静默跳过。
- **服务端怎么选**：在该平台已发布、未删除、版本号高于资源版本的行里取版本最高的一行。
  - wgt 行还要满足：原生版本 ≥ 最低原生版本，并且原生版本不等于审核中的版本。
  - 只要满足条件的行里有一行是强制更新，提示就是强制的：跳过一个强制版本也躲不掉。
  - 版本号是 1–4 段数字，按段比较数值（`1.2` = `1.2.0`，`1.10` > `1.9`）。
- **强制更新在 App 端**：下载或安装失败、关掉弹窗、从商店或浏览器返回后，都会再弹出提示。
- **制作和发布 wgt**：
  1. 先调高 `manifest.json` 的 `versionName`（它就是 wgt 的版本号）。
  2. HBuilderX → 发行 → 原生 App-制作移动 App 资源升级包。
  3. 上传到一个 https 地址，在管理页加一行 wgt。
- **何时必须发整包**：改了原生层（新增模块或权限、升级 uni-app/HBuilderX 或 SDK）必须发整包。之后的 wgt 要把「最低原生版本」填成这个整包的版本，否则旧基座装上新资源会出错。
- **商店审核期间**：提交审核前，把参数 `app.update.review_version` 设成提交的原生版本号。审核期间这个原生版本拿不到 wgt（其他原生版本照常热更新，整包照常提示）；审核通过后清空。iOS 的热更新不得改变 App 的主要功能（App Store 规则）。
- **安全**：
  - 持有 `settings.appVersion.create` / `modify` 权限的人可以向所有设备下发代码（wgt），只授予发布管理员。
  - 下载地址只允许 https。
  - 安装时用 `force: false`：版本不高于当前、或 appid 不同的 wgt，会被运行时拒绝。
  - 包本身没有额外的校验和；以后包放到别人的主机上时，再加 sha256 列和校验。
- **安卓权限**：安卓整包走浏览器下载，App 内不安装 APK，所以不需要 `REQUEST_INSTALL_PACKAGES` 权限（App 权限列表不变）。
- 发布与真机核对项见[发布清单](#发布清单) 第 3、4 节。

### App 权限（安卓）

`manifest.json` 的 `app-plus.distribute.android.permissions` 只列代码用到的权限：`ACCESS_NETWORK_STATE`、`ACCESS_WIFI_STATE`（网络状态）与 `CAMERA` + `android.hardware.camera`（资料页换头像，`uni.chooseImage` 可拍照）。DCloud 模板默认带的读手机状态、账户、日志、系统设置、挂载文件系统、改网络/WLAN、闪光灯、振动、唤醒锁等已删除，`mobile-manifest.spec.ts` 校验列表。新功能要用某项原生能力时才加对应权限，同一提交里更新该测试，并在隐私政策（[发布清单](#发布清单) 第 3 节）的权限说明里写明用途与申请时机。

## 发布清单

每次正式发布都按顺序执行，逐项打勾（把本节复制进发布记录里勾）。标「首次」的项只在第一次发布、换主体或换域名时做。真机核对的结果写进发布记录（第 5 节）。

### 1. 发布前（小程序与 App 共用）

- [ ] 首次：把生成器示例页从发布包里拿掉。登记过的页面即使没有入口，也会随小程序和 App 一起上线。
  - 删掉 `mobile/src/pages.json` 里 `pages-biz` 分包的 9 个页面条目 `demo/{book,topic,invoice}/{index,detail,form}`。没登记的页面和它们的 api 不再编译；`mobile/src/locales/*/demo.*.json` 仍会随语言包打进主包（很小）。
  - 同时删掉 `mobile/e2e/mobile-codegen.spec.ts`：它按 URL 打开这些页面，页面没登记就会失败。
  - `mobile/src/pages-biz/demo/**`、`mobile/src/api/demo/`、语言片段和 `demo_*.cg.ts` 都留着：它们是代码生成器的 golden，`pnpm gen:check-golden` 和 `codegen-render.spec.ts` 会逐字比对。
  - 不建议彻底删掉示例源码。真要删 `pages-biz/demo/**`、`api/demo/` 和 `locales/*/demo.*.json`，还要把 `apps/server/src/db/seeds/codegen/demo_{book,topic,invoice}.cg.ts` 的 `withMobile` 改成 `false`，并改写 `apps/server/test/codegen/codegen-render.spec.ts` 里 `describe('mobile')` 中用 demo 种子做输入的用例。
- [ ] `pnpm ci:local` 全绿（在上一项之后跑）。
- [ ] 调高 `mobile/src/manifest.json` 的 `versionName`（如 `1.2.0`）和 `versionCode`（只增不减的整数，如 `120`）。App 的更新检查比较的是 `versionName`；`versionCode` 是安卓安装和应用市场判断升级用的。小程序上传时的版本号也用这个 `versionName`。
- [ ] 服务端（生产环境，见 `docs/deploy.md`）：
  - API 域名已做 ICP 备案，HTTPS 证书支持 TLS 1.2 及以上、证书链完整（iOS 不接受自签名证书）；
  - 反向代理对 `/socket.io/` 放行 WebSocket 升级（与 web 端相同）；
  - `CORS_ORIGIN` 先不用为移动端改，真机核对后按需添加（第 4 节"实时推送"）；
  - 需要的功能已开启：微信登录（`auth.wx_mp.enabled`，`WX_MP_APPID` / `WX_MP_SECRET` 在 `apps/server/.env.local`）、订阅消息（`notify.wx_subscribe.*`）、App 更新（`app.update.enabled`）。
- [ ] 构建时带上 API 地址。不带的话请求发往相对路径 `/api`，小程序和 App 都连不上。下列为 macOS / POSIX，Windows 用[PowerShell 示例](#windows-命令powershell-51)：

  ```bash
  VITE_API_BASE=https://<API 域名>/api pnpm mobile:build:mp-weixin   # 同时检查包体积
  VITE_API_BASE=https://<API 域名>/api pnpm mobile:build:app
  ```

### 2. 微信小程序

首次（微信公众平台 mp.weixin.qq.com）：

- [ ] 用企业主体注册小程序并完成小程序备案；服务类目选与实际功能一致的类目。
- [ ] AppID 填进 `mobile/src/manifest.json` 的 `mp-weixin.appid`，也填进 `apps/server/.env.local` 的 `WX_MP_APPID`（见"微信小程序登录"）。`mp-weixin.appid` 为空时，产物 `project.config.json` 里是 `touristappid`，不能上传。
- [ ] 开发管理 → 开发设置 → 服务器域名：
  - request 合法域名和 uploadFile 合法域名都填 `https://<API 域名>`（上传走后端 `POST /api/storage/objects`）；
  - socket 合法域名填 `wss://<API 域名>`（实时推送；不配也能用，只是角标退回 60 秒轮询）；
  - downloadFile 合法域名不用配：小程序不下载文件（附件只显示文件名）；
  - 域名只能用 https / wss，必须已备案，不能是 IP 或 localhost；
  - `manifest.json` 里 `mp-weixin.setting.urlCheck: false` 只让微信开发者工具不校验域名；体验版和正式版在真机上一律校验。
- [ ] 用户隐私保护指引：设置 → 服务内容声明 → 用户隐私保护指引（也可以在提交审核时填写）。按代码实际调用的隐私接口声明。下表于 2026-10-02 对照微信官方文档核实过；规则会变，每次提审前留意提审页的提示。

  | 指引里的信息类型     | 代码里的调用                                    | 用途（示例写法）     |
  | -------------------- | ----------------------------------------------- | -------------------- |
  | 选中的照片或视频信息 | `uni.chooseImage`（个人资料页换头像）           | 更换头像             |
  | 选中的文件           | `uni.chooseMessageFile`（`QwUpload`，附件上传） | 上传审批或单据的附件 |
  - 不要勾没用到的：位置、手机号（指 `getPhoneNumber` 按钮；短信登录的手机号是用户自己输入的）、摄像头（指 `<camera>` 组件）、通讯录、剪贴板等。`uni.login`、`uni.requestSubscribeMessage`、`uni.uploadFile` 不是隐私接口。
  - 开发者自己收集的个人信息（账号、姓名、手机号、头像、部门、审批内容与附件）写进指引的补充文档，或写进《隐私政策》。
  - 第一次调用隐私接口时，微信会自动弹出官方的隐私授权弹窗（基础库 2.32.3 起），代码不用处理。没在指引里声明的接口会直接失败（错误码 112，`api scope is not declared in the privacy agreement`）。修改指引约 5 分钟后生效。
  - 新功能用到别的隐私接口时，在同一提交里更新这张表。

- [ ] 订阅消息（可选）：按上文"微信订阅消息"一节选模板、配置 `notify.wx_subscribe.templates`、打开开关。如果后台开了 API IP 白名单，把服务器的出口 IP 加进去。
- [ ] 用 `miniprogram-ci` 上传的话：开发管理 → 开发设置 → 小程序代码上传，下载"代码上传密钥"（`private.<AppID>.key`），放在仓库外（`.gitignore` 已忽略 `private.*.key`）；同时开启"IP 白名单"，只填上传机器的出口 IP。

每次：

- [ ] 上传，二选一：
  - 微信开发者工具：导入 `mobile/dist/build/mp-weixin`（AppID 与 `manifest.json` 一致）→ 上传；版本号填 `versionName`，备注写本次的变更。
  - `miniprogram-ci`（MIT）：不加进依赖，用 `npx` 临时运行，版本写死。下列续行为 POSIX，Windows 用[单行示例](#windows-命令powershell-51)：

    ```bash
    npx miniprogram-ci@2.1.31 upload \
      --pp mobile/dist/build/mp-weixin \
      --pkp <仓库外的目录>/private.<AppID>.key \
      --appid <AppID> \
      --uv <versionName> --ud "<变更说明>" \
      -r 1 --enable-es6 true
    ```

    `--enable-es6 true` 与产物 `project.config.json` 里的 `es6: true` 一致；`-r` 是机器人编号（1–30）。
- [ ] 版本管理：把上传的开发版设为体验版 → 在真机上按第 4 节核对 → 提交审核 → 审核通过后发布。小程序必须登录才能用：提审时说明登录方式，并提供一个测试账号（用测试数据，不要用真实员工的账号）。

### 3. App（安卓 / iOS）

首次：

- [ ] HBuilderX（版本见"HBuilderX 打包"）登录 DCloud 账号；`manifest.json` 的 `appid` 填 DCloud 应用标识（manifest 可视化编辑器里"重新获取"），`name` 填应用名称。
- [ ] 安卓：
  - 包名（如 `com.example.qiwu`）在云打包时填写，上架后不能再改。
  - 签名证书二选一：DCloud 云端证书（本地不需要文件），或自有证书（上架应用市场时推荐；证书丢了，同一包名就再也发不了更新）。自有证书这样生成：

    ```bash
    keytool -genkeypair -alias qiwu -keyalg RSA -keysize 2048 -validity 36500 -keystore qiwu.keystore
    ```

    keystore 和密码放在仓库外（例如密码管理器），并另做备份；`.gitignore` 已忽略 `*.keystore`、`*.jks`。

  - 隐私政策弹窗：国内应用市场要求用户同意之前不申请权限、不读设备信息。在 `mobile/src/` 下（与 `manifest.json` 同目录）放 `androidPrivacy.json`，`pnpm mobile:build:app` 会把它复制进 `dist/build/app`。用模板模式（`"prompt": "template"`），正文链接到隐私政策和用户协议的网页。这个文件里不能写注释。格式见 DCloud 文档"Android 平台隐私与政策提示框"。
- [ ] iOS：
  - 用公司的 Apple 开发者账号，在开发者后台建 App ID（Bundle ID，如 `com.example.qiwu`）。
  - 发布证书（导出成带密码的 `.p12`）和 App Store 类型的描述文件（`.mobileprovision`），云打包时上传。它们放在仓库外，`.gitignore` 已忽略 `*.p12`、`*.mobileprovision`、`*.cer`。
  - 相机和相册的用途说明已经写在 `manifest.json` 的 `app-plus.distribute.ios.privacyDescription` 里（`NSCameraUsageDescription`、`NSPhotoLibraryUsageDescription`）。`uni.chooseImage` 两个来源都会用到，缺了用途说明，iOS 调用时会闪退，审核也会被拒。目前只有中文文案，系统语言是英文的 iPhone 也弹中文提示。措辞可以直接改；新增原生能力时补上对应的用途说明，增删用途说明时同步 `mobile-manifest.spec.ts`（它要求键集合完全一致）。
- [ ] 隐私政策和用户协议：内容是部署方自己的法律文本，放在一个 https 网页上。
  - 登录页页脚的"隐私政策""用户协议"现在打开"关于"页（`mobile/src/pages/login/index.vue` 的 `openAbout`），发布前改成打开这两个网页。
  - 政策里的权限说明照"App 权限（安卓）"一节的列表写：相机（换头像、拍照上传）、网络状态，写明用途和什么时候申请。
- [ ] 上架资料：国内安卓应用市场通常要软件著作权证书、隐私政策网址和截图；App Store 要审核备注和测试账号（同样用测试数据）。
- [ ] 离线打包（可选，替代云打包）：用与 HBuilderX 同版本的 DCloud App 离线 SDK，在 Android Studio / Xcode 里集成 `dist/build/app` 的资源，步骤见 DCloud 文档。

每次：

- [ ] 构建：macOS / POSIX 用 `VITE_API_BASE=… pnpm mobile:build:app`，Windows 用[PowerShell 示例](#windows-命令powershell-51) → HBuilderX 导入 `mobile/dist/build/app` → 发行 → 原生 App-云打包（选好证书和描述文件）。
- [ ] 只改了页面和脚本、没动原生层的，可以只发 wgt（见"App 版本更新"）。改了原生层（模块、权限、升级 uni-app / HBuilderX）必须发整包，之后的 wgt 要填「最低原生版本」。
- [ ] 提交商店审核前，把参数 `app.update.review_version` 设成提交的原生版本号；审核通过后清空。

### 4. 真机核对

设备：一台安卓手机、一台 iPhone，各自跑小程序体验版和云打包的 App（不要用 HBuilder 基座：它写死了浅色）。每台设备浅色、深色各一遍，中文、英文各一遍（可以交叉覆盖）。

外观：

- [ ] 小程序：右上角胶囊按钮与自定义头部（登录页、tab 页的海军蓝头部）垂直对齐，不挡内容。
- [ ] 自绘 tab 栏：文案随语言切换，图标的亮/暗版本正确，角标正常。
- [ ] 深色：小程序和 App 都跟随系统；App「我的」→「外观」三个选项即时生效，重启后保持。
- [ ] 安卓：能读到系统主题；键盘弹起时登录页换成紧凑头部，输入框不被挡住。把实际表现记进发布记录。只有出问题时才设置键盘模式 `softinputMode`（`adjustPan` 为默认，或 `adjustResize`），写在 `pages.json` 里 `pages/login` 的 `style["app-plus"]`。确实要改全部页面的 `globalStyle["app-plus"]` 时，同步修改 `mobile-theme.spec.ts` 里对它的 `toEqual` 断言。
- [ ] iOS：刘海和底部 Home 指示条处的安全区留白正确（tab 栏、底部操作栏、弹层）。
- [ ] 海军蓝页面（登录、微信绑定、tab 页）切换主题后，状态栏仍是白字（模拟器上没复现，要在真机上看）。
- [ ] App 图标和启动图在安卓、iOS 上清晰、不变形。

功能：

- [ ] 登录：账号密码、短信、验证码（按参数 `captcha.mode`）；"记住用户名"；退出后回到登录页。
- [ ] 小程序：静默登录；未绑定时进入绑定页，绑定后再打开直接进工作台。
  - 换网绑定：未绑定时进入绑定页，切换网络（Wi‑Fi ↔ 4G/5G）后再提交绑定，记录是否被当作换 IP 拒绝（绑定票据记下了静默登录时的 IP，提交时 IP 不同就拒绝，要重新进入小程序）。服务端在反向代理后面时须正确配置 `TRUST_PROXY`，否则记下的是代理的 IP。
- [ ] 审批：待办列表、详情、通过 / 驳回 / 退回 / 转办等动作；发起请假和动态表单；附件上传（小程序从聊天记录选文件，App 选图片）。
- [ ] 换头像：拍照和相册都试一次。小程序第一次调用时弹出微信的隐私授权；iOS 第一次拍照时弹出系统的相机权限提示，文字是 `manifest.json` 里的用途说明。
  - 旧版安卓：在一台安卓 12 及以下（API ≤ 32）的真机上从相册选图，换头像和审批附件各一次，能选中并上传才算通过（权限列表里没有 `READ_EXTERNAL_STORAGE`）。失败时按"App 权限（安卓）"一节补权限，并同步修改 `mobile-manifest.spec.ts`。
- [ ] 切换语言后，各页、tab 栏和系统弹窗的语言一致。
- [ ] 实时推送：在电脑端让员工提交请假，主管手机上的待办角标和消息角标在 **2 秒内**各加 1（小程序、App 分别试）；切到后台再回来，能重连并补拉计数；管理员在电脑端强退这个会话后，手机 2 秒内回到登录页并给出提示。
  - 如果角标要等约 60 秒才变（轮询兜底），先查 socket 合法域名和反向代理的 WebSocket 升级。
  - 再查握手是否被拒为 `forbidden_origin`：真机的 WebSocket 握手可能带 `Origin` 头，它既不是本站的源、也不在 `CORS_ORIGIN` 里时，服务端会拒绝。
  - 在反向代理上临时记录 `/socket.io/` 请求的 `Origin` 头（nginx 用 `$http_origin`），把看到的值原样加进 `CORS_ORIGIN`（逗号分隔，与已有的值并列；只加看到的那个值，不要放宽），然后重启服务端。`CORS_ORIGIN` 同时是 web 端刷新令牌接口的 Origin（CSRF）白名单（`apps/server/src/core/http/origin.ts`），加进去的源也能凭 refresh cookie 换新令牌。
- [ ] 订阅消息（有真实的 AppID、AppSecret 和模板时）：小程序「我的」页出现「新待办微信提醒」，点击后微信弹窗申请订阅；之后给这个用户派一个新待办，微信服务通知里收到提醒，点开进入该审批的详情。没订阅或开关关闭时不发。
- [ ] App 版本更新（安卓 App、iOS App 各一遍）：
  1. 开关关闭：没有提示。
  2. 可选 wgt：提示里有"稍后"；点"立即更新"后下载、安装并自动重启，重启后不再提示这个版本。
  3. 强制 wgt：提示里没有"稍后"；下载失败（例如断网）后再次弹出。
  4. 整包：安卓打开浏览器下载，iOS 打开 App Store 页面；强制更新时，从商店或浏览器返回 App 后再次弹出。
  5. 审核版本：`app.update.review_version` 等于当前原生版本时，收不到 wgt。
- [ ] 小程序包体积：发布构建的 mp-size 输出里主包 ≤ 2 MB（超限时构建直接失败）。

### 5. 发布记录

每次发布记一条：日期、`versionName` / `versionCode`、小程序上传的版本号、HBuilderX 版本、设备型号与系统版本、微信版本，以及上面每一项的 ✓ / ✗ 和发现的问题。发布记录由部署方随发布资料保存。

## 测试与检查

- `pnpm mobile:test`：vitest 单测（`mobile/src/**/__tests__/*.spec.ts`，Node 环境，不加载 uni 编译器）。
- `pnpm mobile:e2e [spec]`：Playwright 跑 H5 构建（本机 Edge，`PW_CHANNEL` 可改）；用例文件名一律带 `mobile-` 前缀（如 `mobile-login.spec.ts`，spec 文件名须全仓唯一）。先在仓库根 `pnpm -r build`（用后端的 dist）。后端用 `apps/server/.env.local` + `.env.e2e`，但数据库 `qiwu_mobile_e2e`（首次用 qiwu 账号建库，每次运行清空重建）、Redis db 9、端口 3201、上传目录 `apps/server/data/mobile-e2e-upload`，H5 预览端口 4175，因此可与 web 的 Playwright（`qiwu_e2e` / 14 / 3200 / 4173）同时运行。
- 实时推送的 e2e（`mobile-push.spec.ts`）通过 `vite preview` 的 `/socket.io` 代理连真实服务端；代理必须写成对象形式 `{ target, ws: true }`，不能加 `changeOrigin`（否则 Origin 检查会判为外站，返回 `forbidden_origin`）。断言三件事：推送后 2 秒内刷新角标；强退后 2 秒内回到登录页；进入后台时断开、回到前台 2 秒内重连。只测轮询的用例，要先用 `page.routeWebSocket(/\/socket\.io\//, (ws) => ws.close())` 挡掉 socket。
- 选择器：用公共类定位——登录选项卡 `.qw-login__tab`、审批分段 `.qw-seg__item`、时间线 `.qw-tl__item`、表单摘要 `.qw-kv`、菜单 `.qw-menu__item`、空状态 `.qw-empty`；移动端 e2e 没有像素基线，视觉改版后在本机 Edge 402×874 下按浅色/深色、中/英文逐屏截图人工对照 `docs/design/visual-system.md` §12。
- `pnpm mobile:verify`：`vue-tsc`（应用与 Node 侧两份 tsconfig）+ 移动端许可证检查（`../scripts/license-check.mjs --dir .`，例外登记在 `mobile/license-exceptions.json`：`caniuse-lite` CC-BY-4.0、`qrcode-terminal` 的非 SPDX 写法 `Apache 2.0`、`z-paging@2.8.8` 缺 license 字段（仓库为 MIT，升级时重新核对）；只对 `mobile/` 生效）。
- `pnpm -C mobile audit:report`：`pnpm audit`，把 DCloud 锁死的告警（经 `@dcloudio/*`、`vite`、`vue-i18n`、`vitest` 引入）单列，只报告；其余 high/critical 使其失败。需联网，发布前运行，不进 `verify`，也不影响主工程的 `pnpm audit --prod` 门槛。
- 根目录：`pnpm verify` 的 `i18n:check`、`originality:check` 也扫描 `mobile/src`（没有中文字面量、不出现其他后台项目的标识）；`license:check` 在 `mobile/` 已安装时一并检查它（未安装则提示跳过）。`pnpm ci:local` 在 `mobile/` 存在时依次跑 `mobile:install`、`mobile:verify`、`mobile:test`、`mobile:build:h5`、`mobile:build:mp-weixin`（含包体积检查），并在 web 的 Playwright 之后跑 `mobile:e2e`（`--parallel` 时与它同在 Playwright 通道）。

## 升级 uni-app

用官方工具 `npx @dcloudio/uvm@latest --manager pnpm`（在 `mobile/` 下）统一升级 `@dcloudio/*`，并与本机 HBuilderX 版本对齐；`vite`、`vue`、`@vue/runtime-core`、`@dcloudio/types` 跟随它要求的精确版本。之后跑 `pnpm i`（不得出现 ERR_PNPM_IGNORED_BUILDS，需要时改 `mobile/pnpm-workspace.yaml` 的 `allowBuilds`）、`pnpm mobile:verify`、三个平台的构建与 `pnpm mobile:e2e`。

## 只要 PC：删除移动端

`mobile/` 之外只有下列几处提到它（`scripts/arch/mobile-refs.mjs` 的白名单），全部在 `mobile/` 不存在时无害，删掉是为了干净：

1. 删除 `mobile/` 与本文件 `docs/mobile.md`。
2. 根 `package.json`：删除全部 `"mobile:*"` 脚本。
3. `.oxlintrc.json` 的 `ignorePatterns` 删 `"mobile/**"`；`.prettierignore` 删 `mobile/` 及其注释行；`eslint.config.mjs` 删 `'mobile/**',`。
4. `scripts/ci-local.mjs`：删 `const MOBILE = …` 与 5 个 `mobile …` 步骤；`scripts/i18n-check.mjs`、`scripts/originality-check.mjs`、`scripts/license-check.mjs`：删 `const MOBILE = …` 及用到 `MOBILE` / `mobile` 的几行（都在"不存在则跳过"的分支里）。
5. 代码生成器：`apps/server/src/modules/platform/codegen/workspace.ts` 的 `export const MOBILE = …` 和 `scripts/gen-check-golden.mjs` 的 `const MOBILE = …` 是 mobile-refs 白名单里的两行，其余路径都由这个常量拼出；模板目录 `apps/server/codegen-templates/uni/` 只用来渲染移动端页面。`mobile/` 不存在时，`hasMobile()` 为假：生成器不渲染、不写、也不打包移动端页面，`demo_*.cg.ts` 里的 `withMobile: true` 不产出任何文件，`gen:check-golden` 也不比对移动端文件，所以这几处都可以留着。想删的话：删掉 `codegen-templates/uni/`，再把 `crud.ts` 里的移动端目标、`withMobile` 选项和编辑页开关一并去掉（不建议，留着无害）。
6. 可选：删除 `scripts/arch/mobile-refs.mjs` 与 `apps/server/test/arch/arch-mobile-refs.spec.ts`。
7. macOS / POSIX 执行 `pnpm i --frozen-lockfile && pnpm verify`；Windows 用下列顺序检查。全绿，根 `pnpm-lock.yaml` 不变（移动端从未进入根锁定文件）。删除演练仅在可丢弃副本进行。

```powershell
pnpm.cmd i --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "Install failed" }
pnpm.cmd --filter @qiwu/shared build
if ($LASTEXITCODE -ne 0) { throw "Shared build failed" }
pnpm.cmd verify
if ($LASTEXITCODE -ne 0) { throw "Verify failed" }
```

## Windows 命令（PowerShell 5.1）

原生 Windows 11 + Windows PowerShell 5.1（含 cmd 入口）已验证用于开发与完整本地闸门（`pnpm ci:local --serial`）；无文件 symlink 权限时，符号链接防护测试跳过；Windows 服务器部署及 App / 小程序发布未验证。MySQL / Redis ≥ 7 服务、浏览器和测试库由用户准备，见[入门清单](getting-started.md#windows原生-powershell-51)。

`pnpm.cmd` 仅随 npm / Corepack 安装提供，避免 `.ps1` 执行策略且不改执行策略；独立 `pnpm.exe`（winget / get.pnpm.io）使用 plain `pnpm`，将下列 `pnpm.cmd` 换成 `pnpm`。 根 workspace 与 mobile 依赖独立；在仓库根逐行安装与检查，每步失败停止：

```powershell
pnpm.cmd mobile:install
if ($LASTEXITCODE -ne 0) { throw "Mobile install failed" }
pnpm.cmd mobile:verify
if ($LASTEXITCODE -ne 0) { throw "Mobile verify failed" }
pnpm.cmd mobile:test
if ($LASTEXITCODE -ne 0) { throw "Mobile tests failed" }
```

构建小程序 / App 必须指定自己真实的 API 域名。以下在变量原先未设置的终端执行；已有值先保存，完成后恢复原值。用 `$env:` 赋值、`$LASTEXITCODE` 控制步骤、`Remove-Item Env:` 清除，避免 PowerShell 5.1 管道 / 重定向传递中文：

```powershell
$env:VITE_API_BASE='https://api.example.com/api'
try {
  pnpm.cmd mobile:build:mp-weixin
  if ($LASTEXITCODE -ne 0) { throw "Mini-program build failed" }
  pnpm.cmd mobile:build:app
  if ($LASTEXITCODE -ne 0) { throw "App build failed" }
} finally {
  Remove-Item Env:VITE_API_BASE
}
```

只构建一个目标时保留对应命令。不要把 uni-app 是否读取 `.env.production.local` 当作已验证的替代方案；需实机确认产物请求地址。App 构建后再按发布清单用 HBuilderX 导入并打包，工具、证书与真实设备结果另行记录。

miniprogram-ci 上传属于有账号、证书、网络时才人工执行的发布步骤，不是自动验收。替换下列 AppID、版本、说明和仓库外密钥路径；使用 npm 提供的 `npx.cmd`，全部参数在一行，路径与中文说明加引号：

```powershell
npx.cmd miniprogram-ci@2.1.31 upload --pp mobile/dist/build/mp-weixin --pkp "C:/private keys/private.APPID.key" --appid APPID --uv 1.2.0 --ud "本次变更说明" -r 1 --enable-es6 true
if ($LASTEXITCODE -ne 0) { throw "Mini-program upload failed" }
```

上传前须完成第 2 节的 AppID / 密钥 / IP 白名单条件。上述上传命令未在 Windows 上实测；含中文参数时请自行确认 PS 5.1 的编码。PC-only 删除后的 install → verify 命令见上一节；在目标 Windows 环境记录实际检查结果。
