# 设计说明

English summary: Qiwu separates framework, platform, workflow and project code. Shared schemas define validation and API contracts; Redis-backed opaque sessions, permission checks and scoped database access protect requests. This document describes the reusable design and links to detailed guides.

本文说明栖梧管理后台的公共设计约定，供业务扩展、代码注释与集成文档引用。

<a id="layering"></a>

## 分层与项目扩展

`core` 提供横切能力，`platform` 是平台模块，`workflow` 是流程模块，项目领域放业务代码。lint 与架构检查强制三条依赖规则：

- `core` 从不导入任何模块；
- `platform` 从不导入 `workflow` 或项目领域；
- `workflow` 从不导入项目领域。

项目领域可以使用以上各层。前后端共享 schema、类型与权限常量放在 `@qiwu/shared`。

项目代码放在 `modules/<领域>/<业务>`、`views/<领域>/<业务>`、`api/<领域>/` 与 shared 的领域目录，通过 `ProjectModule` 和项目种子注册。领域取表名第一段；包作用域保持 `@qiwu/*`。详见[代码生成指南](codegen.md)。

<a id="api-envelope"></a>

## API 与响应信封

资源路由使用 `/api/<领域>/<复数-kebab-case>`。成功响应为 `{ code: 0, msg, data }`，分页的 data 为 `{ items, total }`；失败响应携带业务码、已翻译的 msg 和 traceId，校验失败可附字段 errors。HTTP 状态表达真实语义：400 校验失败、401 未认证、403 无权限、404 不存在或超出数据范围、409 冲突、422 业务拒绝、429 限流或重复提交。

分页使用共享 `pageQuery`，排序字段须在白名单内。数据库会话与时间存储使用 UTC，API 时间为 ISO-8601，界面按本地时区显示；请求追踪号贯穿日志与审计。

<a id="auth-sessions"></a>

## 认证与会话

访问令牌与刷新令牌是不透明随机值，服务端以哈希和 Redis 会话验证身份。控制台 access 保存在内存，通过 Bearer 头发送；refresh 放在 HttpOnly、SameSite=Strict、限定 Path 的 cookie 中，刷新接口检查 Origin。刷新轮换并检测重用，滑动续期不能越过会话绝对上限。保持登录控制 cookie 的持久性。

控制台、移动端与第三方 OAuth 客户端隔离，第三方令牌只进入显式开放的协议接口。改密、停用、删除与强退通过统一撤销服务清理凭据和连接；必须改密或密码过期时由服务端限制可访问端点。详见[安全基线](security.md)与[OAuth2](oauth2.md)。

<a id="permissions"></a>

## 权限与授权

权限码使用 `<domain>.<resource>.<verb>`，由各模块的 `xxxPerms` 导出，前后端同源。服务端使用 `@RequirePerm` 检查任一或全部权限，前端通过 `v-perm` 与 `usePerm` 显示操作入口。菜单隐藏不代替服务端授权。

权限来源为用户启用角色所关联的启用菜单的权限码并集；权限版本变化后，会话重新加载权限及部门范围。非超级管理员只能授予自己拥有的权限与数据范围，不能授予 root。内置 root 按角色代码及内置标志识别，不依赖固定数据库 id。

<a id="data-scope"></a>

## 数据范围与引用

数据范围包括全部、指定部门、本部门、部门子树与本人记录。带范围的实体通过 `scopedQb` 查询；写操作先在事务内用 `lockScopedIds` 锁定可见行，批量中任一 id 不存在或越界时整体返回 404。新增与编辑还需检查可写部门及属主。

软删除唯一性使用未映射的 `alive` 生成列；引用登记处理存活检查、限制删除与级联。规则链保留租户扩展点，但当前没有租户隔离。详见[数据权限](data-scope.md)与[多租户改造边界](multi-tenancy.md)。

<a id="audit"></a>

## 审计与追踪

实体审计订阅器从请求上下文填入创建人和更新人。每个非 GET 控制器方法声明 `@ActionLog` 或显式 `@SkipActionLog()`；登录日志、HTTP 访问记录与故障记录有各自入口。项目自定义动作在项目动作词种子中注册。

日志共用敏感字段脱敏与大小限制，追踪号连接请求、错误与审计记录。配置保留期的清理任务物理删除过期记录；记录失败会写运行日志，审计不代替业务事务。

<a id="i18n"></a>

## 国际化

界面、后端消息、共享校验及字段标签同时提供 zh-CN 与 en-US。菜单和种子显示名使用翻译键；字典、参数等运行期内容可保存双语 JSON，并保留原文回落。界面切换语言时同步组件库、日期库与第三方组件，并向后端发送语言头。

校验消息使用 `validation.*`，字段标签使用 `field.<domain>.<prop>`。不要在业务源码硬写中文提示；详见[国际化指南](i18n.md)。

<a id="validation"></a>

## 校验与共享契约

Zod schema 放在 `@qiwu/shared`，同时生成类型、服务端请求校验、Swagger 描述与表单规则。输入校验由服务端最终执行，浏览器规则用于提前反馈；排序、标识符与动态表单行为均受白名单约束。

schema 注册字段领域，派生 schema 也需注册；校验问题转换为翻译键与参数。服务端不维护独立的 validation / field 文案副本，详见[校验选型](adr/003-validation.md)。

<a id="crud-kit"></a>

## CRUD 页面与对话框

列表使用 `QwTable` 与 columns 数组，通过 `#cell-<prop>` 和 `#actions` 扩展单元格与操作；`TableToolbar` 使用同一列配置，`table-id` 为 `<domain>.<biz>`，用户列偏好由 `useTablePrefs` 保存。

新增与编辑表单是接收可选 id、发出 done/cancel 的对话框内容组件，使用 `useCrudForm`，通过 `openDialog` 打开。提交期间按钮显示 loading 且禁用；创建接口另有短时幂等保护。详见[黄金样板](codegen-golden.md)。

<a id="codegen"></a>

## 代码生成

生成器从数据库元数据与配置输出单表、树与主子模块，包括服务端、shared、Web、权限、种子与测试。预览和下载不写工作区；工作区写入须显式启用并检查目标、覆盖和路径安全。生成器不复制其他后台模板实现。

黄金样板由配置重新渲染并逐字节比较，模板与样板应一起更新；项目菜单组和动作词通过项目种子重建。详见[代码生成指南](codegen.md)与[黄金样板](codegen-golden.md)。

<a id="workflow"></a>

## 流程与表单

树形与 BPMN 设计器共享树形运行引擎，画法与表单来源独立。发布形成版本快照；审批、分支、抄送与超时动作按结构化配置执行，拒绝脚本、表达式和监听器。BPMN 只支持可编译到树形模型的子集，并保留 bpmn.io 标志。

业务表单通过注册表接入，动态表单受双端 schema 白名单与字段访问控制；计算值由服务端重算。详见[流程接入](bpm.md)、[BPMN 设计器](workflow-bpmn.md)与[超时处理](workflow-timeout.md)。

<a id="storage"></a>

## 文件存储

本地与 S3 存储共用对象元数据、标签与属主检查。public 本体可由反向代理托管，private 文件通过鉴权 API 下载；上传检查大小、类型、魔数与路径，直传确认再次验证属主和对象。改变 S3 目标或访问密钥时必须重填 secret。

多实例本地存储要求共享卷，也可使用共同的 S3 配置；出站连接受地址与端口限制。详见[部署指南](deploy.md)与[安全基线](security.md)。

<a id="realtime"></a>

## 实时与通知

Socket.IO 握手验证会话，按用户与用户类型发送业务事件；事务相关通知在提交后推送。多实例使用 Redis 分片适配器，部署间以 Redis 库号和频道前缀隔离。

推送不持久化，也不支持连接状态恢复；可靠数据先落库，经 REST 补拉，客户端保留重连刷新与轮询。详见[实时推送](realtime.md)、[通知中心](notify.md)与[多实例部署](scale-out.md)。

<a id="security"></a>

## 安全默认值与验证码

默认要求认证，写操作检查权限、数据范围与日志；SQL 参数化，富文本清洗，出站连接防 SSRF，文件和 Excel 有内容及资源限制。秘密只进入忽略的 `.env.local` 或进程环境，不能放入 `VITE_*`；生产拒绝测试凭据标记。

验证码模式为 off / image / slider，默认 slider；图形使用自绘字形，滑块使用 sharp 生成拼图。校验成功发出单次票据，绑定场景和 IP；跨 IP 的账号失败计数可强制验证码，即使普通模式关闭。验证码与限流、失败计数共同工作。详见[安全基线](security.md)与[环境准备](getting-started.md#2-空库账号与隔离)。

<a id="mobile"></a>

## 可选员工移动端

`mobile/` 是独立于根 pnpm workspace 的 uni-app Vue 3 员工客户端，复用 shared 契约与现有审批接口，面向小程序和 App，H5 用于调试。PC 管理端仍以桌面浏览器为目标。

PC 项目可按步骤删除 mobile；真机、外部消息与发布需要在目标环境核对，动态表单部分控件和附件仍有限制。详见[移动端指南](mobile.md)。
