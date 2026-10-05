# 通知：模板、事务与失败恢复

业务通知统一调用 `Notifier.send(input: NotifySend): Promise<NotifyRecordIds>`。当前 `NOTIFY_CHANNELS` 只有 `inbox`、`mail`、`sms`；各渠道自己的消息记录表承担 outbox，没有独立的 `ws` 渠道或 WebSocket outbox 记录。

## 发送契约

业务服务注入 `Notifier` 后，可在现有 `@Transactional()` 方法内调用。例如流程提醒使用已有模板码：

```ts
const ids = await this.notifier.send({
  template: 'wf.task.overdue',
  to: [assigneeId],
  params: await this.taskParams(task),
  channels: ['inbox'],
})
```

`assigneeId`、`task` 与 `taskParams()` 来自业务服务，流程中的真实调用见 `WfNotify.overdue()`（它省略 `channels`）。返回值形如 `{ inbox: [recordId] }`，是已插入记录的 id，不是收件人已收到或第三方投递成功的证明。

| 字段                             | 当前行为                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `template: string`               | 模板 code；各渠道查询该 code 的启用、未软删除模板行                                                                         |
| `to: NotifyTo[]`                 | 用户 id，或 `{ email: string }`、`{ mobile: string }`；不存在或已删除的用户被跳过，不能指望它自动检查业务授权或验证外部地址 |
| `params?: NotifyParams`          | 传入类型化参数，见下表；未给出时为空对象                                                                                    |
| `channels?: NotifyChannelCode[]` | 省略则遍历三个已注册渠道；只有存在启用模板行的渠道才写记录，没有模板或没有注册渠道时不会自动报发送失败                      |

用户收件人的邮箱、手机号、语言、时区来自 `iam_user`。直接地址没有 `userId`，采用发送请求的语言和时区；inbox 仅支持用户 id，直接地址不会产生站内信。mail / sms 缺少地址时写 `skipped` 与 `no_address`，不进入重试。数字用户 id 去重；直接地址对象按对象身份去重，不承诺同地址的不同对象一定合并。

模板选择顺序为接收人语言 → `DEFAULT_LOCALE`（`zh-CN`）→ 查询得到的第一条启用行。模板管理应维护完整双语，避免依赖最后一层回落。

| 参数值                             | 渲染                                           |
| ---------------------------------- | ---------------------------------------------- |
| `string` / `number` / `boolean`    | `String(value)`                                |
| `null`                             | 空字符串                                       |
| `{ dict: 'code', value: 'value' }` | 取接收人语言的字典标签，再回落普通标签或原值   |
| `{ i18n: 'key' }`                  | 按接收人语言翻译，不存在时回落键本身           |
| `{ datetime: 'ISO 时间点' }`       | 接收人时区格式化到分钟；无效时间字符串保留原文 |

`fillTemplate()` 单次替换 `{name}`，缺少参数的占位符保留，替换值不再作为模板扫描。HTML 邮件只对替换参数做 HTML 转义，模板本身的清洗由模板管理服务承担；站内信是纯文本。完整语言和时区回落见[国际化文档](i18n.md)。

## 事务提交之后派发

`Notifier.send()` 用 `TransactionHost.tx` 写每个渠道和收件人的记录。处于 `TransactionHost` / `@Transactional()` 活动事务时，记录 id 收集到 QueryRunner 的 `notifyPending`，最外层提交后由 `NotifyTransactionSubscriber.afterTransactionCommit()` 合并交给 `NotifyDispatcher.start()`；派发使用 `withoutTransaction()`，不会沿用已经提交的事务管理器。最外层回滚清除待派发列表，消息记录随业务事务回滚。

没有活动事务时，插入后直接 `await dispatcher.flush(ids)`。普通投递失败记录在渠道状态中；数据库插入本身的错误仍可抛出。无事务的多渠道写入没有整体回滚保证；需要业务与全部记录原子提交时应使用现有事务入口。

原生 `dataSource.transaction()` 不会自动成为 `TransactionHost` 的当前事务。直接在其中调用 `Notifier.send()` 会按无事务路径写入和派发，不能保证跟随这个原生事务回滚；业务通知必须接入项目的 CLS 事务入口。

## 条件 claim、恢复与重复投递边界

inbox、mail、sms 的 `deliver(id)` 先按主键条件更新：有效记录、`attempts < NOTIFY_MAX_ATTEMPTS`，并且状态是 `pending/failed`，或是超过 claim 超时的 `sending`。成功 claim 才设为 `sending`、尝试数加一并写 `claimed_at`；更新零行表示不归本次派发所有，不发送。

当前常量：`NOTIFY_MAX_ATTEMPTS = 3`，指总共最多三次尝试；`NOTIFY_CLAIM_TIMEOUT_MS = 10 * 60_000`，指 `sending` 超过十分钟后可以回收，不是每条失败消息固定等十分钟。发送成功后 inbox 标为 `delivered`，mail / sms 标为 `sent`；异常标为 `failed`。最终更新同时比较本次 `claimed_at` 与 `sending` 状态，避免旧派发者覆盖接手者状态。

`NotifyDispatcher.dispatch()` 的 `notify.dispatch` 作业先调用各渠道 `expire()`，再按创建时间和 id 查询 `due(100)` 并派发。种子默认每分钟扫描一次（`0 * * * * *`）；测试环境首次插入该作业时禁用，测试主动调用。实际恢复依赖调度器运行、作业启用与配置，不能把一分钟当交付 SLA。

`pending/failed` 或超时 claim 且仍有尝试次数的记录可重试。超时且已耗尽次数的 `sending` 由 `expireClaims()` 标为 `failed`，邮件/短信同时写 `interrupted`；耗尽次数的失败记录不会被普通扫描继续发送。

条件 claim 防止正常并发派发者重复领取同一记录，但不能保证外部系统只收到一次：第三方已接受发送、进程却在写成功状态前崩溃，恢复后可能再次发送；WebSocket 发出后在状态更新前失败也有同类窗口。业务要避免重复效果，应按业务标识或记录 id 幂等处理，不能把 `sent/delivered` 当作用户已读。

## WebSocket、微信订阅与离线推送

`InboxChannel.deliver()` 领取后调用 `RealtimeService.toUser()` 推送 `RT.notifyNew`（`notify:new`），payload 是 `{ id, title }`；随后在同一 claim 条件下更新 inbox 为 `delivered`。只有成功更新为 `delivered` 的那次投递才调用 `InboxChannel.onDelivered()` 监听器。客户端离线时，消息仍留在 inbox，重新上线通过 HTTP 获取站内信；WebSocket 没有收到并不意味着站内信插入失败。实时连接与多实例条件见[实时推送](realtime.md)和[多实例部署](scale-out.md)。

已有 `WxSubscribeService` 注册 `onDelivered()`，在 `notify.wx_subscribe.enabled` 打开、应用配置齐全、模板映射有效且接收人有当前应用有效绑定时发送微信一次性订阅消息。微信维护订阅额度；该钩子不建独立 outbox 或普通重试记录，无额度时跳过。访问令牌被拒绝可刷新并再试一次，但不是通知扫描的失败重试机制。监听器失败被记录，不回滚已经投递的站内信；进程在站内信标为 delivered 后崩溃也可能漏掉钩子。

App 离线推送规划采用个推（Getui），目前计划中；当前三渠道契约没有 `app_push`、`getui` 或 `ws`，也没有已实现的个推渠道。不要把微信订阅与 App 厂商/APNs 离线推送混为一项。

## 短信验证码的独立路径

登录、找回、绑定手机号的 OTP 不走 `Notifier` 普通 outbox。`SmsOtpService` 使用 `SmsNotifyChannel.writeClaimed()` / `sendClaimed()`：普通短信记录里的 code 被遮蔽为 `******`，记录直接占用全部尝试数，真实 code 只放在临时发送消息中；普通 `due()` 不会把它作为可重试验证码发送。发码限额、验证码消费与认证逻辑由 OTP 服务负责，不应通过业务通知示例绕过。

## 源码与观察清单

入口与恢复逻辑均在 [core/notify/notify.ts](../apps/server/src/core/notify/notify.ts)（`NotifySend`、`Notifier`、`NotifyDispatcher`、`NotifyTransactionSubscriber`、`expireClaims()`）。渠道：[InboxChannel](../apps/server/src/modules/platform/messaging/inbox/inbox.channel.ts)、[MailChannel](../apps/server/src/modules/platform/messaging/mail-template/mail-channel.ts)、[SmsNotifyChannel](../apps/server/src/modules/platform/messaging/sms-template/sms-notify-channel.ts)。关联实现：[微信订阅](../apps/server/src/modules/platform/iam/social/wx-subscribe.service.ts)、[OTP](../apps/server/src/modules/platform/messaging/sms-otp/sms-otp.service.ts)、[调度种子](../apps/server/src/db/seeds/scheduler/scheduler.seed.ts)、[流程调用](../apps/server/src/modules/workflow/runtime/wf-notify.ts)。

人工验收在隔离项目检查：事务提交后记录与通知出现、回滚无记录；无事务发送；缺少地址的 skipped；渠道失败后的状态与重试；两种账号语言与时区；离线重连后的 HTTP inbox。相关回归源码为 `core-notify.spec.ts`、`messaging-inbox.e2e-spec.ts`、`messaging-mail-template.e2e-spec.ts`、`messaging-sms-template.e2e-spec.ts`。
