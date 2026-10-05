# 参与贡献 / Contributing

[中文](#中文) · [English](#english)

## 中文

感谢你关注栖梧（Qiwu）。本文说明如何提交问题、讨论想法和发起合并请求（PR）。安全问题请勿公开提交，见 [安全策略](SECURITY.md)。

### 参与方式

- **问题（Issues）**：报告缺陷或提出功能建议，请使用仓库提供的问题模板，并附上版本、环境与复现步骤。
- **讨论（Discussions）**：用法疑问、设计想法与经验分享适合放在讨论区；方案尚未确定的较大改动，建议先在这里或问题中沟通。
- **合并请求（PR）**：修复缺陷、补充测试、改进文档或实现已讨论过的功能。小而专注的 PR 更容易评审。

### 开发环境

按 [入门指南](docs/getting-started.md) 准备 Node、pnpm、MySQL、Redis 与环境文件，这里不再重复。凭据只写入被 git 忽略的 `apps/server/.env.local`，不要提交任何密钥或个人数据。

### 提交 PR 之前

1. 运行 `pnpm verify`（lint、架构、类型、i18n、原创性与许可检查），必须全部通过。
2. 运行与改动相关的测试：
   - 服务端：`pnpm --filter @qiwu/server test <stem>`，`<stem>` 用完整的 spec 文件名主干（如 `core-auth.e2e`），不要加 `--`。
   - Web 单元测试：`pnpm --filter @qiwu/web test <stem>`。
   - 改动界面时运行 Playwright：`pnpm --filter @qiwu/web e2e <spec>`。
   - 改动 `mobile/` 时运行 `pnpm mobile:verify` 与 `pnpm mobile:test`（`mobile/` 不在工作区内，首次请先执行 `pnpm mobile:install`，见 [docs/mobile.md](docs/mobile.md)）。
3. 较大的改动运行完整本地闸门 `pnpm ci:local`；它会重置测试库，请先按入门指南准备独立的测试数据库与 Redis 库号。
4. 新增或修改的接口需有 e2e 测试，覆盖成功、403、400 / 越权 404；业务逻辑需有单元测试。

### 约定

- **提交信息**：遵循 Conventional Commits，scope 为 `<domain>/<module>`，如 `feat(iam/user): …`、`fix(web/workflow): …`；提交时由 commitlint 检查 Conventional Commits 格式（scope 的写法靠评审把关）。
- **i18n 优先**：`.ts` / `.vue` 中不写硬编码中文；每个词条同时提供 `zh-CN` 与 `en-US`。位置与规则见 [国际化](docs/i18n.md)。
- **视觉**：颜色、圆角与阴影只使用 `--qw-*` 令牌，组件中不写原始十六进制颜色；Element Plus 覆盖只放在 `apps/web/src/styles/element.css`。见 [视觉规范](docs/design/visual-system.md)。
- **校验**：zod schema 放在 `@qiwu/shared`，校验消息使用 `validation.*` 词条键。
- **权限**：权限码格式为 `<domain>.<resource>.<verb>`，如 `iam.user.browse`。
- **数据库**：只使用参数化 SQL；新表、迁移与命名约定见 [代码生成](docs/codegen.md) 与 [黄金样板](docs/codegen-golden.md)。
- **审计**：每个非 GET 的控制器方法都要有 `@ActionLog` 或 `@SkipActionLog()`。
- **依赖**：新依赖必须通过 `pnpm license:check`（MIT、ISC、BSD、Apache-2.0 等；不接受 GPL、AGPL 或仅 LGPL 许可），并说明引入理由；带安装构建脚本的依赖要同时在 `pnpm-workspace.yaml` 的 `allowBuilds` 中登记，否则 `pnpm i` 会报 `ERR_PNPM_IGNORED_BUILDS`。
- **测试文件名**：spec 文件名在全仓库唯一，测试过滤使用完整主干，不能是另一个 spec 名称的子串。
- **项目代码位置**：业务代码放项目域目录，见 [代码生成](docs/codegen.md)。

### 原创性

栖梧以 MIT 发布，所有实现必须原创。可以参考其他后台系统的功能与架构，但**不得复制**它们的代码、SQL、种子数据、模板、i18n 文案或 UI 组件。第三方资产与许可义务见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

### PR 检查清单

- [ ] `pnpm verify` 通过
- [ ] 已运行相关测试（服务端 / Web 单元 / Playwright / 移动端）
- [ ] 新增文案同时有 `zh-CN` 与 `en-US`
- [ ] 行为或配置变化已更新文档
- [ ] 没有从其他项目复制代码、SQL、种子数据、模板、文案或组件
- [ ] 没有提交密钥、凭据或个人数据

### 许可

提交贡献即表示你同意你的贡献按本仓库的 [MIT 许可](LICENSE) 发布。

## English

Thank you for your interest in Qiwu (栖梧). This guide explains how to report issues, start discussions and open pull requests. Do not report security issues in public; see the [security policy](SECURITY.md).

### Ways to contribute

- **Issues**: report bugs or suggest features with the issue templates, including version, environment and reproduction steps.
- **Discussions**: questions, design ideas and experience reports belong in Discussions. For larger changes whose approach is still open, please discuss there or in an issue first.
- **Pull requests**: bug fixes, tests, documentation and features that have been discussed. Small, focused PRs are easier to review.

### Development setup

Follow the [getting-started guide](docs/getting-started.md) for Node, pnpm, MySQL, Redis and environment files; it is not repeated here. Keep credentials only in the git-ignored `apps/server/.env.local` and never commit secrets or personal data.

### Before opening a PR

1. Run `pnpm verify` (lint, architecture, types, i18n, originality and license checks); it must pass.
2. Run the tests related to your change:
   - Server: `pnpm --filter @qiwu/server test <stem>`, using the full spec file stem (for example `core-auth.e2e`) and no `--`.
   - Web unit tests: `pnpm --filter @qiwu/web test <stem>`.
   - Playwright when the UI changes: `pnpm --filter @qiwu/web e2e <spec>`.
   - For changes in `mobile/`: `pnpm mobile:verify` and `pnpm mobile:test` (`mobile/` is outside the workspace; run `pnpm mobile:install` first, see [docs/mobile.md](docs/mobile.md)).
3. For larger changes, run the full local gate `pnpm ci:local`. It resets the test databases, so prepare the isolated test databases and Redis database numbers from the getting-started guide first.
4. New or changed endpoints need e2e tests covering success, 403 and 400 / out-of-scope 404; business logic needs unit tests.

### Conventions

- **Commit messages**: Conventional Commits with scope `<domain>/<module>`, such as `feat(iam/user): …` or `fix(web/workflow): …`; commitlint checks the Conventional Commits format on commit (the scope shape is checked in review).
- **i18n first**: no hard-coded Chinese text in `.ts` / `.vue` files; every key exists in both `zh-CN` and `en-US`. See [i18n](docs/i18n.md) for locations and rules.
- **Visual style**: colors, radius and shadows only through `--qw-*` tokens, never raw hex colors in components; Element Plus overrides live only in `apps/web/src/styles/element.css`. See the [visual system](docs/design/visual-system.md).
- **Validation**: zod schemas live in `@qiwu/shared`; validation messages are `validation.*` i18n keys.
- **Permissions**: permission codes use `<domain>.<resource>.<verb>`, such as `iam.user.browse`.
- **Database**: parameterized SQL only; table, migration and naming conventions are in [code generation](docs/codegen.md) and the [golden examples](docs/codegen-golden.md).
- **Auditing**: every non-GET controller method has `@ActionLog` or `@SkipActionLog()`.
- **Dependencies**: a new dependency must pass `pnpm license:check` (MIT, ISC, BSD, Apache-2.0 and similar; no GPL, AGPL or LGPL-only licenses), and the PR explains why it is needed; a dependency with install/build scripts must also be listed under `allowBuilds` in `pnpm-workspace.yaml`, otherwise `pnpm i` fails with `ERR_PNPM_IGNORED_BUILDS`.
- **Spec file names**: unique across the repository; test filters use the full stem, never a substring of another spec name.
- **Project code**: application code goes into project-domain directories; see [code generation](docs/codegen.md).

### Originality

Qiwu is released under MIT and every implementation must be original. Other admin systems may be referenced for features and architecture only; **never copy** their code, SQL, seed data, templates, i18n strings or UI components. Third-party assets and license obligations are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### PR checklist

- [ ] `pnpm verify` passes
- [ ] Related tests were run (server / web unit / Playwright / mobile)
- [ ] New strings exist in both `zh-CN` and `en-US`
- [ ] Documentation is updated for changed behavior or configuration
- [ ] No code, SQL, seed data, templates, strings or components copied from other projects
- [ ] No secrets, credentials or personal data committed

### License

By contributing, you agree that your contributions are released under this repository's [MIT license](LICENSE).
