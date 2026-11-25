# 员工通话的 LiveKit 接入

本应用负责员工身份、邀请、接听资格和通话历史；LiveKit 负责 RTC 媒体。Web/H5 使用官方 JS SDK，App 使用官方 Swift/Android SDK 的 uni-app 原生桥。无需 GPU，不部署语音识别或模型服务。范围是前台员工通话，不含后台接听、离线推送、录制、屏幕共享或外部会员。

## 服务与凭据

当前没有预置可用服务。支持的自托管服务端固定为 **v1.13.11**，部署时必须禁止自动建房；升级前重新核验配置与删除后的旧凭据行为。

在服务器上安装该版本的官方二进制，以非 root 服务账号运行 `livekit-server --config /etc/livekit/livekit.yaml`，由系统服务管理器管理进程。下面 TURN/TLS 直接监听 443 时，Linux 服务还需授予 `CAP_NET_BIND_SERVICE`（例如 systemd 的 `AmbientCapabilities` 与 `CapabilityBoundingSet` 都仅包含该能力）；也可在独立四层负载均衡器后使用高位监听端口。配置文件仅服务账号可读，不提交真实凭据。下面是单节点配置的结构，尖括号内容必须换成现场配置：

```yaml
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
room:
  auto_create: false
keys:
  <generated-api-key>: <generated-random-secret>
turn:
  enabled: true
  domain: turn.example.com
  tls_port: 443
  udp_port: 3478
  cert_file: /etc/livekit/tls/fullchain.pem
  key_file: /etc/livekit/tls/privkey.pem
```

为 `media.example.com` 的 HTTPS/WSS 入口准备受信任证书；WebSocket/API 的 7880 放在 TLS 代理后，禁止从公网明文访问管理入口。TURN/TLS 示例使用独立公网 IP 的 `turn.example.com:443`，不能与相同 IP 上的 HTTPS 监听冲突。NAT 后的节点要保证公布的公网地址和实际端口可达。官方说明见 [部署](https://docs.livekit.io/transport/self-hosting/deployment/) 和 [端口](https://docs.livekit.io/transport/self-hosting/ports-firewall/)。

本样板用 UDP mux 7882，开放节点的 UDP 7882、TCP 7881，以及 TURN 的 TCP 443 / UDP 3478；选用 UDP 范围时按实际配置开放该范围，不能只开 7880 就认为媒体可用。TCP/TURN 是受限网络的回退路径，仍须在目标网络实测。带宽按参与者上行、订阅数和画质估算，并实测 CPU、丢包与重连；小群上限 8 人不是服务器容量承诺。

应用服务的非秘密配置：

```dotenv
APP_IM=true
IM_LIVEKIT_URL=wss://media.example.com
IM_LIVEKIT_API_URL=https://media.example.com
```

`IM_LIVEKIT_API_KEY`、`IM_LIVEKIT_API_SECRET` 仅写在应用服务器的 git-ignored `.env.local` 或受保护环境变量；与 LiveKit 的 keys 对应。不要放在 `.env`、`VITE_*`、App manifest、页面参数或前端包里。三个 URL/凭据共同配置后，在系统参数中打开 `im.call.enabled`。配置不齐不发媒体票据，`GET /api/im/options` 会明确报告通话是否配置。

控制 URL 与客户端 URL 都只接受源，不带用户信息、路径、查询串或片段。生产使用 HTTPS/WSS；loopback HTTP/WS 仅本机开发。控制面复用应用的公网目标和 DNS 重绑定防护，默认只开放 443；确需其它公网端口时用 `OUTBOUND_LIVEKIT_PORTS` 显式登记，不影响 S3/SMTP 的端口规则。内网开发沿用既有 `ALLOW_PRIVATE_ENDPOINTS`，不要为通话在生产全局解除私网防护。

## 代理与浏览器策略

为媒体源配置 WebSocket upgrade，并关闭 `/rtc` 的请求 URL 日志。官方 SDK 的信令协议可能把临时访问票据放进握手查询串；不能把业务层“票据只在内存”误写为传输层绝无查询串。TLS、代理和错误采集均须避免记录它：

```nginx
location /rtc {
    access_log off;
    proxy_pass http://127.0.0.1:7880;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

控制 API 同样代理到 LiveKit，由服务端短期管理授权保护；可再用可信应用节点 IP 限制 `/twirp/`。不要对媒体入口套会把 Authorization、查询串或响应正文持久化的调试中间件。

构建 Web 时设置 `CSP_CONNECT_SRC=https://media.example.com,wss://media.example.com`（使用 S3 时保留其源），按 [部署指南](deploy.md) 生成并同步完整 CSP 到 nginx。`script-src` 仍为 `'self'`；`media-src 'self' blob:` 支持本机语音播放。不要用通配符放开脚本。麦克风/摄像头还要求安全上下文和用户授权。

## 授权、结束与故障处理

服务端先持久化唯一媒体房间的创建意图，再调用控制 API。临时客户端 JWT 仅 60 秒、仅指定房间和麦克风/摄像头发布订阅，不能建房、管理、录制或共享屏幕；不入消息、缓存、页面数据、日志或组件 props。TTL 限制新入场时间，不负责立刻断开已有连接。

`ImCallMaintenanceModule` 在 all/api/worker 实例上始终装配，与 `APP_IM` 和新通话参数无关；每 5 秒通过会续租的 Redis 锁处理有界批次。关闭新通话仍继续清理存量。控制请求失败保持待处理状态，未知 CreateRoom 结果不会盲目重试或凭 DeleteRoom not-found 假结束。恢复网络后由 ListRooms/删除收敛；无法证明未创建的未知意图需要运维核对，不能直接在数据库改为 ended。

更换控制地址、切换集群、轮换或移除控制凭据前，先关闭新通话并等待所有存量/未知创建清空；存在待清理通话而缺凭据时启动会明确失败。故障时检查不含票据的受控错误、控制面可达性、待处理行与服务器状态。不要把数据库的 ending 改为 ended 来消除界面提示，也不要复用旧媒体房间名。

## 接入验收

- HTTPS/WSS、证书链、客户端与应用服务器都能访问；Web、Android、iPhone 的双向语音与摄像头画面互通，音频路由切换和权限拒绝可恢复。
- Wi-Fi、蜂窝、禁 UDP 的网络分别验证；确认 TURN 真正在受限网络传输，测试断网、重连和挂断后停止采集。
- 使用仍在有效期内的旧客户端 JWT：成功 DeleteRoom 后再连接同一媒体名必须失败；普通客户端无 create 权限、`room.auto_create: false` 均保持。确认没有迟到创建后才验收终局。该项必须用真实服务，SDK 替身和数据库状态不能代替。
- 退出、被踢、租户/员工停用、退群、移除成员、关闭开关及控制面中断期间核对清理；记录断开窗口和重试结果，不承诺网络故障时即时撤销远端媒体。

仓库自动化验证与原生编译不能证明现场媒体可用。当前尚无真实 LiveKit 服务和目标设备媒体验收记录；原生构建与真机清单见 [移动指南](mobile.md) 与 [插件说明](../mobile/src/uni_modules/qw-livekit/README.md)。
