# 后台智能体（智能助手）

“智能助手”是后台里的一个对话页面：业务人员用自然语言让智能体查数据、做汇总、按要求修改数据；需要外部信息时它联网搜索并阅读网页，修改前把“改哪条记录、每个字段的旧值 → 新值、依据哪些来源”交给人确认。也可以对列表里选中的多条记录批量执行一个技能（如“补齐客户信息”），结果进批次审批页逐条或一次确认。

智能体只通过工具办事：工具就是各模块用 `@McpTool` 声明的方法（与 [MCP 智能体接入](mcp.md)同一个注册表与执行护栏），外加内置的联网工具、计划清单与反问。它不执行命令、不读写服务器文件、不操作浏览器。模型经兼容 OpenAI 的 Chat Completions 接口接入（官方 SDK `openai`，Apache-2.0），国内外常见的模型服务与本地 Ollama 都能用。

接口与类型见共享包 [agent.schema.ts](../packages/shared/src/platform/agent/agent.schema.ts)，服务端代码在 [apps/server/src/core/agent/](../apps/server/src/core/agent/)，页面在 [apps/web/src/views/platform/agent/](../apps/web/src/views/platform/agent/)。测试：开关 [agent-switch.e2e-spec.ts](../apps/server/test/e2e/agent-switch.e2e-spec.ts)，模型提供方 [agent-provider.e2e-spec.ts](../apps/server/test/e2e/agent-provider.e2e-spec.ts)，运行时、审批与限额 [agent-runtime.e2e-spec.ts](../apps/server/test/e2e/agent-runtime.e2e-spec.ts)，会话功能 [agent-threads.e2e-spec.ts](../apps/server/test/e2e/agent-threads.e2e-spec.ts)，联网工具与提示注入 [agent-web.e2e-spec.ts](../apps/server/test/e2e/agent-web.e2e-spec.ts)，外部 MCP [agent-mcp-client.e2e-spec.ts](../apps/server/test/e2e/agent-mcp-client.e2e-spec.ts)，技能 [agent-skills.e2e-spec.ts](../apps/server/test/e2e/agent-skills.e2e-spec.ts)，附件 [agent-attachments.e2e-spec.ts](../apps/server/test/e2e/agent-attachments.e2e-spec.ts)，批量执行 [agent-batch.e2e-spec.ts](../apps/server/test/e2e/agent-batch.e2e-spec.ts)，浏览器里走一遍“补齐 → 审批 → 写入”见 [agent-chat.spec.ts](../apps/web/e2e/agent-chat.spec.ts)。

## 启用

| 开关                       | 位置                                         | 作用                                                                                                                                                                  |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_AGENT`                | 服务端环境变量，默认 `false`                 | 只在启动时读取，切换须全部实例重启。关闭时模块不加载：`/api/agent/*` 全部 404，不注册队列处理器，侧栏、角色授权树与租户套餐里不显示“智能体”菜单组，右下角入口也不出现 |
| `agent.paused`（系统参数） | 系统参数页，默认 `false`，**只有 root 能改** | 急停：为 `true` 时拒绝新的对话轮次与工具调用，正在运行的轮次在半秒内停下；改回 `false` 即恢复。经参数缓存失效对所有实例生效                                           |

`APP_AGENT` 与 `APP_MCP` 互不依赖：两者共用工具注册表，但只开 `APP_AGENT` 时 `/api/mcp` 仍不存在。智能体的表始终由迁移创建，菜单与示例数据始终由种子写入（[agent.seed.ts](../apps/server/src/db/seeds/agent/agent.seed.ts)），打开开关不需要额外迁移；关着时菜单由 [menu-features.ts](../apps/server/src/core/auth/menu-features.ts) 隐藏。

打开后的第一步：

1. root 在“智能体 → 智能体设置 → 模型”里添加一个模型提供方（见下节）；没有可用模型时对话页提示联系管理员，输入框不可用。
2. 需要联网时在“联网搜索”页签添加一个搜索服务商。
3. 在“角色管理”给业务角色授权“智能助手”（`agent.chat.use`）；还要用技能管理、批量执行、用量页的再授权对应页面。root 看得到全部菜单。
4. 多租户时，把“智能体”菜单组勾进租户套餐，该租户的角色才能被授权；“智能体设置”是平台页，只属于默认租户。

菜单组“智能体”紧跟首页，下有四页：

| 页面       | 权限点                                                                            | 内容                                                                     |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 智能助手   | `agent.chat.use`                                                                  | 对话页；批次审批页挂在它下面（隐藏菜单，批量执行权限 `agent.batch.run`） |
| 技能管理   | `agent.skill.browse` / `create` / `modify` / `remove`，`agent.instruction.modify` | 个人与全租户技能、提示词模板、租户说明                                   |
| 智能体设置 | `agent.setting.browse` / `agent.setting.modify`（平台页，改动只有 root）          | 模型、联网搜索、外部 MCP、工具策略、平台技能、说明与限额                 |
| 智能体用量 | `agent.usage.browse`                                                              | 按日、用户或模型汇总的调用次数与 token                                   |

## 配置模型

“智能体设置 → 模型”里每个提供方填：名称、接口地址（base URL，到 `/v1` 这一级，系统在后面接 `/chat/completions`）、密钥、可用模型列表，可设为默认。每个模型可标注：显示名、是否支持推理强度（对话里可选低 / 中 / 高，发 `reasoning_effort`）、是否能看图片（附件里的图片只交给这类模型）、是否作为“快速”选项、上下文窗口（默认 64000 token，决定何时自动压缩）。

常见服务的接口地址（模型名以各家文档为准，密钥在各家控制台申请）：

| 服务                   | 接口地址                                            | 模型名示例        |
| ---------------------- | --------------------------------------------------- | ----------------- |
| DeepSeek               | `https://api.deepseek.com/v1`                       | `deepseek-chat`   |
| 通义千问（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`       |
| Kimi（月之暗面）       | `https://api.moonshot.cn/v1`                        | `moonshot-v1-32k` |
| 智谱                   | `https://open.bigmodel.cn/api/paas/v4`              | `glm-4-plus`      |
| Ollama（本机或内网）   | `http://127.0.0.1:11434/v1`                         | `qwen2.5:14b`     |
| OpenAI                 | `https://api.openai.com/v1`                         | `gpt-4.1-mini`    |

智能体依赖模型的工具调用（function calling）能力，请选支持它的模型。不需要密钥的本地服务（Ollama）密钥留空。

- 密钥只写不读：用 `APP_SECRET` 派生的独立密钥加密存库，接口只返回 `hasKey`；保存时不填密钥即保留原密钥，但改了接口地址必须重新填（原密钥不会被发到新地址）。`APP_SECRET` 变更后旧密钥打不开，须重新填写。
- 会话可以从已配置的提供方与模型里选；没选时用默认提供方的第一个模型。
- 上游的报错正文不外传（可能回显密钥片段或提示词），页面只看到“模型服务调用失败”与简短原因（超时、HTTP 状态、网络）。只在 429 与 5xx 时小退避重试两次。

## 联网搜索

内置两个只读工具：

- `web.search`：经配置的搜索服务商搜索公网，先支持 [博查](https://open.bochaai.com/)（国内）与 [Tavily](https://tavily.com/)（海外）。在“联网搜索”页签添加服务商（类型、名称、密钥，可设默认），密钥同样加密存库、只写不读；没有配置时不提供这个工具。
- `web.fetch`：读取一个网页（HTML 转成纯文本，也接受纯文本与 JSON），**只能读本轮 `web.search` 返回过的链接、用户消息里给出的链接，或白名单网站的链接**。

两个系统参数（root，在“联网搜索”页签或系统参数页修改）：

| 参数                        | 默认   | 作用                                                                                   |
| --------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `agent.web.mode`            | `live` | `live` 联网；`off` 不提供任何联网工具                                                  |
| `agent.web.allowed_domains` | 空     | 逗号分隔的域名（含子域名），`web.fetch` 可以直接读；空表示只读搜索结果与用户给出的链接 |

## 外部 MCP 服务器

“智能体设置 → 外部 MCP”可以接入本系统以外的 MCP 服务器（Streamable HTTP），让智能体调用它们的工具。本系统自己的工具仍在进程内调用，不经 MCP。

- **鉴权方式**：`none`；`header`（每次请求带一个请求头令牌，如 `Authorization: Bearer …`，不能设置传输自用的请求头）；`oauth`（OAuth 客户端凭据模式：令牌地址、客户端 id、客户端密钥、可选范围，令牌缓存到过期前）。凭据加密存库、只写不读；改了地址或鉴权方式必须重新填写凭据。
- **地址**：默认只能是公网地址，连接时按解析结果再查一遍（防 DNS 重绑定）。指向内网（如 `http://10.0.0.5/mcp`）须 **root 显式勾选“允许内网地址”**。
- **同步工具**：点“同步”连接服务器并列出其工具。新工具默认**停用**、策略为 `ask`；服务器上消失的工具自动停用。管理员逐个启用并设审批策略；服务器声明的“只读”不可信，只有管理员显式设为 `auto` 的外部工具才会直接执行，其余一律当作写入、调用前要人确认。
- 外部工具在模型那里叫 `ext.<服务器名>.<工具名>`；它的描述、参数说明与返回内容都当作不可信外部内容。服务器在调用中途请求用户补充信息（MCP elicitation）时，对话页显示一张表单卡片，最多等 10 分钟。
- 每次调用记操作日志（同下文的审计）。

## 工具策略

“智能体设置 → 工具策略”列出本系统的全部工具（`@McpTool` 工具与 `web.search` / `web.fetch`），每个一个审批策略，对所有租户生效：

| 策略   | 含义                               |
| ------ | ---------------------------------- |
| `auto` | 直接执行（只读工具的默认）         |
| `ask`  | 停下等发起人确认（写入工具的默认） |
| `deny` | 不提供给智能体                     |

写入工具只能是 `ask` 或 `deny`，设 `auto` 被拒（库里即使被改成 `auto` 也按 `ask` 执行）。“恢复默认”回到按类型的默认值。在“MCP 工具”页整体停用的工具，智能体同样用不了。

## 技能

技能是一段任务说明加上允许使用的工具，例如“补齐客户信息”：逐个联网查官网、行业、城市……只填空字段并给出来源。技能只是说明文字，不含可执行代码。

| 范围 | 谁维护                                                             | 谁能用             |
| ---- | ------------------------------------------------------------------ | ------------------ |
| 平台 | root，在“智能体设置 → 平台技能”                                    | 所有租户的所有用户 |
| 租户 | 持有 `agent.skill.create` / `modify` / `remove` 的人，在“技能管理” | 本租户的用户       |
| 个人 | 本人（有 `agent.chat.use` 即可），在“技能管理”                     | 本人               |

同名时个人的优先，其次租户，最后平台。

- **渐进加载**：模型平时只看到可用技能的名称与描述，判断要用时调用内置工具 `skill.load` 取正文。
- **显式调用**：在输入框打 `$` 选技能（或 `/skills`），本轮直接载入该技能的正文；技能列了工具时，本轮只提供这些工具（内置工具总在）。
- **从会话生成**：`POST /api/agent/skills/from-thread/:id` 让模型根据一次会话起草一个个人技能，保存为停用状态，检查后在技能页启用。
- **导入导出**：技能页可导入、导出 `SKILL.md`。格式（解析见 [skill-md.ts](../apps/server/src/core/agent/skills/skill-md.ts)）：开头用 `---` 包起来的前言，只允许 `name`、`description`（写“什么时候用”）与可选的 `tools`，之后是正文。名称由字母、数字（含中文）与 `-` 组成，最长 64 个字符。

```markdown
---
name: 补齐客户信息
description: '补齐客户资料：联网查官网、行业、城市、规模、电话、地址、简介，只填空字段并给出来源'
tools: [web.search, web.fetch, demo.customer.get, demo.customer.update, ask.user]
---

为选中的客户补齐资料。逐个处理：

1. 用 demo.customer.get 读出现有资料，记下哪些字段为空。
2. 用 web.search 按客户全称搜索，再用 web.fetch 阅读官网或权威页面核实。
3. 搜到多家名字相近的公司时，用 ask.user 让用户选，不要猜。
4. 调用 demo.customer.update 只填空字段；查不到的留空，不要编造。
5. 最后总结补了哪些字段、每个值来自哪个链接。
```

`tools` 也可以写成多行的 `- 项` 列表。

## 说明、语气与提示词模板

- **说明**拼在系统提示里，依次是：平台说明（系统参数 `agent.instructions`，root）→ 租户说明（“技能管理”页，需 `agent.instruction.modify`）→ 个人说明（每个用户自己写，如“回答用表格”）。
- **语气**是个人预设：默认、简洁、详细、友好、正式。
- **提示词模板**：个人或全租户（后者需 `agent.skill.modify`）的常用提问，输入框里用 `/prompts` 插入。

## 限额、急停与用量

系统参数（root）：

| 参数                                | 默认       | 作用                                             |
| ----------------------------------- | ---------- | ------------------------------------------------ |
| `agent.limit.turn_steps`            | `20`       | 每轮最多步数（每请求一次模型算一步）             |
| `agent.limit.turn_seconds`          | `300`      | 每轮最长秒数（按每次运行计，等人确认的时间不算） |
| `agent.limit.turn_tokens`           | `200000`   | 每轮 token 上限                                  |
| `agent.limit.user_daily_tokens`     | `1000000`  | 每用户每日 token 上限（UTC 日）                  |
| `agent.limit.tenant_daily_tokens`   | `10000000` | 每租户每日 token 上限（UTC 日）                  |
| `agent.limit.user_concurrent_turns` | `2`        | 每用户同时运行的轮次数（等人确认的轮次不算）     |
| `agent.trust_mode`                  | `true`     | `false` 时不提供“信任本会话”审批模式             |
| `agent.paused`                      | `false`    | 急停，见[启用](#启用)                            |

超限时这一轮停下，并在对话里说明是哪个上限；超出并发时新消息被拒（429）。用量按用户、租户、模型与日期记账，“智能体用量”页按日、用户或模型汇总当前租户的调用次数与输入 / 输出 token；输入框旁的 `/status` 显示本会话的上下文用量、本轮与今日用量和上限。

## 对话页

- **会话**：左侧列表可新建、搜索（标题与消息全文）、改名、置顶、归档 / 恢复、删除，按“全部 / 进行中 / 未读 / 置顶”筛选；第一条消息自动生成标题。临时会话不进列表，离开即删（闲置 24 小时的也会被清理）。
- **分叉与撤回**：从任意消息分叉出新会话（复制到该条为止的内容）；“编辑后重发”最后一条消息也是分叉；“撤回”删除最后一轮及其条目——已经执行的写入**不会回滚**。
- **分享与导出**：分享生成只读链接，只有同租户的人能打开，查看者只看得到自己有权调用的工具的结果；导出为 Markdown；单条消息可复制、点赞点踩并留言。
- **审批模式**（每个会话可切换，`/approvals`）：`只读`（只提供只读工具）、`询问`（默认，每次写入都确认）、`信任本会话`（同一工具对同一目标确认过一次后，本会话内不再询问）。审批卡片列出工具、目标记录、逐字段的旧值 → 新值与本轮读过的来源，按钮为“确认执行 / 本会话内同意 / 拒绝 / 取消本轮”（卡片获得焦点时 Enter 确认、Esc 拒绝）。拒绝时可写一句说明，智能体收到“用户拒绝”后不再重试。缺权限、只读模式或平台策略挡住的调用显示一张说明缺什么的卡片。
- **计划模式**（`/plan`）：只读，智能体先列出计划，你确认后再切回执行。多步任务里智能体用内置工具 `plan.update` 维护清单，面板实时显示进度。
- **反问**：智能体不确定时用内置工具 `ask.user` 提 1–4 个问题，每题 2–4 个选项（单选或多选）加“其他”自由填写；本轮停下等回答，也可以选择不回答。
- **附件**：消息可附带最多 10 个已上传到文件存储、发送人有权读取的文件。文本类（txt、md、csv、json、log）读入前 200 KB，xlsx 取第一张表转成 CSV，png / jpeg / webp / gif（5 MB 以内）交给能看图片的模型，其余类型只告诉模型文件名。
- **运行中发消息**：默认“追加到本轮”，排在当前步骤之后处理，用来改方向；也可选“排到下一轮”。随时可以点“停止”。
- **上下文压缩**：用量接近模型上下文窗口的 80% 时自动把较早的对话压成摘要继续，对话里显示一条分隔标记；也可手动 `/compact`。输入框旁的圆环显示上下文用量。
- **斜杠命令**：`/new` 新会话、`/compact` 压缩、`/model` 切换模型、`/approvals` 审批模式、`/plan` 计划模式、`/skills` 选技能、`/prompts` 提示词模板、`/mcp` 打开外部 MCP 设置、`/status` 用量与状态、`/clear` 清空并新建。
- **其他**：支持的模型显示可折叠的“思考”摘要；回答后给出 0–3 条后续建议；回答里引用的网页列在末尾。一轮停下等你确认或回答，以及耗时超过 30 秒的一轮完成时，发站内信提醒。
- **右下角入口**：任意页面右下角的“智能助手”按钮带着当前页面跳到对话页；列表页用 [use-agent-context.ts](../apps/web/src/views/platform/agent/chat/use-agent-context.ts) 的 `useAgentContext` 公布选中的记录，智能体就知道“这几条”指什么。

## 批量执行与“补齐客户信息”示例

示例业务“示例客户”（`demo_customer`，菜单“生成示例 → 示例客户”）预置了几家知名公司，部分字段故意留空；平台技能“补齐客户信息”与三个工具配套：

| 工具                   | 类型 | 权限点                 | 说明                                                                                          |
| ---------------------- | ---- | ---------------------- | --------------------------------------------------------------------------------------------- |
| `demo.customer.search` | 只读 | `demo.customer.browse` | 按名称查客户，返回 id、名称与仍为空的字段                                                     |
| `demo.customer.get`    | 只读 | `demo.customer.view`   | 一个客户的全部资料                                                                            |
| `demo.customer.update` | 写入 | `demo.customer.modify` | 填官网、行业、城市、规模、电话、地址、简介；默认只填空字段，审批卡片列出每个字段的旧值 → 新值 |

在对话页直接说“补齐华为技术有限公司的行业”，或在列表里勾选几个客户点“让智能体补齐”：每个客户一个会话、一轮，按发起人的并发上限依次开始，每条修改都停在审批上；批次审批页列出每一行的状态与待确认的修改，可逐条确认，也可以“全部确认 / 全部拒绝”。批量执行需要 `agent.batch.run`，只能对自己能读到的记录建批次。

代码：工具与批量目标 [customer.mcp-tools.ts](../apps/server/src/modules/demo/customer/customer.mcp-tools.ts)，样例数据与技能 [customer-sample.seed.ts](../apps/server/src/db/seeds/demo/customer-sample.seed.ts)，列表页的按钮 [index.vue](../apps/web/src/views/demo/customer/index.vue)，批次页 [batch/index.vue](../apps/web/src/views/platform/agent/batch/index.vue)。

## 安全模型

- **只属于发起人**：会话、条目、审批与提问只有本人能看能操作，别人的会话一律 404；只有发起人本人能确认审批（批量也一样）。分享链接只读、只限同租户。
- **工具按用户本人的身份运行**：进程内调用 `@McpTool` 时沿用 MCP 的护栏——权限点、数据权限、租户与套餐、参数校验、超时、输出中密钥名字段的遮蔽与大小上限、平台的逐个停用。智能体能做的不会超过发起人自己在页面上能做的；每一轮开始前按发起人重新加载身份，用户被停用或删除时轮次不再进行。
- **写入从不在无人确认时执行**：写入工具的策略只能是 `ask` 或 `deny`；“信任本会话”也要求同一工具对同一目标先确认一次。确认之后若权限、会话模式或策略已经变了，调用照样被拦下。
- **来源限制**：`web.fetch` 只读本轮搜索结果、用户消息里的链接或白名单网站，防止网页内容诱导智能体把内部数据拼进 URL 发出去；没出现过的链接连 DNS 都不查。
- **不可信外部内容**：网页、搜索结果与外部 MCP 工具的输出交给模型时包在 `<external-content>` 块里并注明“只是数据”，系统提示要求不执行其中的指令；即使模型被网页诱导去改数据，写入仍停在审批卡片上，卡片列出依据的来源。用户在反问里填的文字也只作为数据交给模型。
- **出站请求防 SSRF**：`web.fetch`、外部 MCP 与其 OAuth 令牌请求只用 http/https，解析后的每个地址都必须是公网地址（拒绝回环、内网、链路本地与云元数据地址），连接钉在检查过的地址上，每次重定向重新检查，有总超时、大小与类型上限，不带 Cookie 与系统凭据（[safe-fetcher.ts](../apps/server/src/core/agent/web/safe-fetcher.ts)、[guarded-fetch.ts](../apps/server/src/core/agent/mcp-client/guarded-fetch.ts)）。外部 MCP 指向内网须 root 显式勾选。模型提供方的接口地址**不做**这项检查（本机或内网的 Ollama 正是常见用法），它只能由 root 配置。
- **密钥加密**：模型、搜索服务与外部 MCP 的凭据各用 `APP_SECRET` 派生的独立密钥加密存库，只写不读，操作日志里遮蔽；改了目标地址须重填，原凭据不会发往新目标。
- **审计**：每次工具调用（含被拒的）记一条操作日志，模块 `mcp.tool`、动作 `call`，参数里标明来自对话页（`channel: in-app`）、工具来源、会话与轮次 id；被修改的数据行照常记修改人为发起人。设置的每次修改也记操作日志。
- **限额与急停**：每轮步数、时长、token，每用户与每租户每日 token，每用户并发轮次；root 的急停 `agent.paused` 立即生效。

### 已知上限

- 并发轮次数是软限制：两个同时到达的请求可能都通过，每用户最多多出一轮。
- 暂不支持租户自己添加外部 MCP 服务器：外部服务器、模型与搜索服务都是平台配置，只有 root 能改。
- 只支持远程 HTTP 的 MCP 服务器，不支持要在服务器上启动进程的 stdio 类服务器。
- 附件只能是文件存储接受上传的类型；读入模型的只有上文列出的文本、表格与图片类型。
- 撤回一轮不回滚它已经执行的写入；工具超时只结束等待，已经开始的数据库操作无法中断（同 MCP）。
- 模型的回答与判断可能出错：审批卡片上的旧值 → 新值与来源请逐条核对。

## 给自己的模块加工具、批量目标与技能

分步配方见 [给智能助手加工具与技能](ai/recipes/agent-skill.md)。要点：

### 工具

工具与 MCP 工具是同一个东西：一个 provider 方法加 `@McpTool`（[mcp-tool.ts](../apps/server/src/core/mcp/mcp-tool.ts)，写法与声明规则见 [MCP 文档](mcp.md#给自己的模块加工具)）。智能体额外用到的是写入工具的 `preview`：同一个 provider 上一个方法的名字，收到同样（已校验）的参数，返回 `{ target, fields: [{ field, from, to }] }`，审批卡片据此显示“改哪条记录、每个字段的旧值 → 新值”。预览方法同样在调用者的数据权限下读数据，读不到就抛 404。

```ts
@McpTool({
  name: 'crm.customer.update',
  title: 'Update a customer',
  description: 'Sets the level or the note of a customer. Cite your sources.',
  perm: customerPerms.modify,
  kind: 'write',
  input: updateInput,
  output: updateOutput,
  preview: 'previewUpdate',
})
async update(dto: z.output<typeof updateInput>) {
  // 写入前在事务里 lockScopedIds，再比较与写入
}

/** 审批卡片：会改哪个客户、每个字段的旧值 → 新值。 */
async previewUpdate(dto: z.output<typeof updateInput>) {
  const c = await this.customers.get(dto.id)
  return { target: `${c.name} (#${dto.id})`, fields: [{ field: 'level', from: c.level, to: dto.level }] }
}
```

### 批量目标

想让列表页对选中行批量执行技能，在同一个 provider 上加 `@AgentBatchTarget({ target, perm, tools })`（[batch-targets.ts](../apps/server/src/core/agent/batch/batch-targets.ts)），并实现 `AgentBatchTargetProvider.batchLabels(ids)`：返回调用者能读到的 id → 记录名（用 `scopedQb`，读不到的不放进结果）。`target` 写 `<domain>.<resource>`，`perm` 是列表的 browse 权限点，`tools` 是批次页“全部确认”可以一起确认的写入工具（必须带 `preview`，预览目标是这一行的记录；不在清单里的写入一律逐条确认，防止某条记录里的网页内容诱导出对别的记录或别的系统的写入被一并放行）。智能体关着时没有人扫描它，模块照常工作。列表页用 `agentBatchApi.create({ skill, target, ids })`（[agent-batch.ts](../apps/web/src/api/platform/agent-batch.ts)）建批次，再打开路由 `agent-batch`，写法同示例客户的列表页。

### 技能

项目自带的技能写成种子：在项目种子里像 [customer-sample.seed.ts](../apps/server/src/db/seeds/demo/customer-sample.seed.ts) 那样只在第一次写入 `agent_platform_skill`（管理员之后的修改与停用保留），登记到 `apps/server/src/db/seeds/index.ts` 的 `SEEDS.project`。技能正文里写清楚每一步用哪个工具、只改什么、查不到时怎么办，并在 `tools` 里只列需要的工具。也可以不写代码，直接在“技能管理”页新建或导入 `SKILL.md`。
