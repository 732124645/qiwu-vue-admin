# 安全策略 / Security Policy

[中文](#中文) · [English](#english)

## 中文

### 支持的版本

| 版本    | 是否支持 |
| ------- | -------- |
| 1.0.x   | 是       |
| < 1.0.0 | 否       |

### 报告漏洞

请通过 GitHub 私密漏洞报告提交：进入仓库 → **Security** → **Report a vulnerability**。**不要**在公开的问题、讨论或 PR 中披露漏洞细节。

报告中请尽量包含：

- 受影响的版本或提交，以及涉及的模块、接口或页面；
- 漏洞类型与影响（如越权访问、注入、信息泄露）；
- 最小复现步骤或概念验证，以及所需的配置与权限；
- 你建议的修复方向（如有）。

请勿在报告中附带真实的个人数据或生产凭据。

### 响应

维护者以尽力而为的方式处理，通常在 7 天内确认收到报告；不提供服务等级承诺（SLA）。确认后我们会与你沟通修复进展。

### 范围

- 范围内：本仓库的模板源码（服务端、Web、共享包与移动端）。
- 公开演示站 [demo.qiwuadmin.com](https://demo.qiwuadmin.com) 运行在演示模式（拒绝业务写操作）。请勿对其进行破坏性测试、压力或负载测试，也不要尝试拒绝服务。
- 基于本模板部署的第三方系统由各自运营者负责，不在本策略范围内。

### 披露

修复版本发布后再公开漏洞细节。我们会在发布说明中致谢报告者（如你希望署名）。

## English

### Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0.0 | No        |

### Reporting a vulnerability

Report privately through GitHub private vulnerability reporting: open the repository → **Security** → **Report a vulnerability**. **Do not** disclose vulnerability details in public issues, discussions or pull requests.

Please include as much as you can:

- the affected version or commit, and the module, endpoint or page involved;
- the vulnerability type and impact (for example broken access control, injection or information disclosure);
- minimal reproduction steps or a proof of concept, with the required configuration and permissions;
- a suggested fix, if you have one.

Do not include real personal data or production credentials in a report.

### Response

Reports are handled on a best-effort basis. We usually acknowledge a report within 7 days; there is no service-level agreement (SLA). After confirming an issue we will keep you informed about the fix.

### Scope

- In scope: the template source in this repository (server, web, shared package and mobile client).
- The public demo at [demo.qiwuadmin.com](https://demo.qiwuadmin.com) runs in demo mode (business writes are refused). Do not run destructive, stress or load tests against it, and do not attempt denial of service.
- Third-party systems deployed from this template are the responsibility of their operators and are out of scope.

### Disclosure

Vulnerability details are disclosed after a fixed release is published. Reporters are credited in the release notes if they wish.
