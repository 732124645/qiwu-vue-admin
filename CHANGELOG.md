# Changelog

中文说明：本文件按功能区域汇总栖梧 / Qiwu 的用户可见变化，正文使用英文。`1.0.0` 于 2026-10-05 发布。

All notable product changes are recorded here in Keep a Changelog style. The initial release below summarizes the delivered features. Planned work is identified explicitly.

## [1.0.0] - 2026-10-05

### Added

#### Identity, organization and access

- Account/password login with safe return navigation, remembered usernames, optional persistent login, logout, lock screen, first-login password changes and password-expiry prompts. Optional registration, SMS login/password recovery, image and slider captchas, and WeChat mini-program account binding are available behind their configuration switches.
- User, role, menu, department and position management, including role assignment, menu grants, custom department scopes, enable/disable actions, password resets, department-tree filtering, details, and supported Excel import/export workflows. Profiles include avatar cropping, password changes and account information.
- Five data-scope modes: all rows, selected departments, the current department, its subtree, and own rows. Session management supports scoped browsing and individual/batch forced logout, including OAuth sessions.
- Dynamic menus support routes, iframes and external links, visibility, sorting, caching and single-child group display through `always_show`.

#### Desktop interface and localization

- Chinese and English interfaces, translated validation/errors, and multilingual menu, dictionary, parameter, template and seed display content. English locale proofreading and strict TODO checks are complete; the mobile English login motto is intentionally blank.
- Side, top and mixed navigation; persisted sidebar collapse and light/dark sidebar variants; light/dark app themes, theme color, layout settings, tags and their context menu, menu search, fullscreen, density controls, dynamic titles and optional username watermark.
- Shared CRUD tables and dialog forms with per-user column preferences, first-load skeletons, viewport-bounded dialogs, footer dividers and common today/7-day/30-day date shortcuts. JSON viewers use read-only syntax highlighting.
- A workbench with workflow tasks, started applications, unread messages, shortcuts and last-login information, plus permission/not-found pages and session-expiry handling. Temporary refresh failures retry before showing service-unavailable state.

#### Settings, audit and operations

- Dictionary types/entries with multilingual labels, tags, exports, cache refresh and a database-enforced single default entry per dictionary. Parameter settings include built-in protection, categories and sensitive-value masking.
- Rich-text bulletins with publication notifications, a latest-items feed, unread counts and read/read-all actions. Login/action logs support filtering, details, deletion, exports and account unlock where applicable; trusted user types are translated through the audit dictionary in pages and exports.
- Configurable HTTP access traces and HTTP fault records with processing states and trace IDs; MySQL status, Redis/cache and host/runtime monitoring; registered cache namespace browsing/clearing; region trees and IP location lookup; Swagger documentation with a deployment switch.
- Scheduled jobs with registered handlers, cron builder, enable/disable, run-once, concurrency controls, misfire policies, retries, timeout monitoring and execution logs.

#### Files, Excel and messaging

- Local and S3-compatible storage configuration, primary storage selection, connection checks, file browsing/upload/deletion/link copying/preview, authenticated private downloads and presigned direct uploads. Changing an S3 endpoint, bucket or access key requires a newly entered secret in both the form and API.
- Excel import/export with dictionary conversion, shared validation, row/archive limits and formula-injection escaping. Avatar uploads are cropped and normalized to WebP.
- Inbox templates, personal messages, unread counts and read actions; email accounts/templates/send records; SMS channels/templates/records, verification codes and callbacks. Delivery is recorded transactionally and dispatched after commit through the notification/outbox mechanism.
- Socket.IO authentication, user/user-type/broadcast targeting, reconnect/polling fallbacks and an original realtime demonstration page. Redis sharded adapters carry cross-instance pushes and forced disconnects; shared Redis rate limiting accumulates requests across service instances.

#### Code generation and project reuse

- Original single-table CRUD, tree and master-detail templates; table import and schema synchronization; column/form configuration, detail views, generated tests, previews, single/batch ZIP downloads and guarded workspace writes. The CLI and golden-output checks keep generated modules aligned with the template contract.
- Project domains derived from table prefixes, reproducible menu groups and project action verbs. Optional mobile CRUD output is generated when the mobile folder exists; `im` / `im_` are reserved for future chat work.
- A Node-only new-project setup script with interactive/CLI input, isolated database and Redis selections, app title configuration, ignored secret files and a no-write dry run. Documentation covers getting started, project setup, deployment, code generation, data scopes, localization, notifications, security and integration boundaries.

#### Workflow and forms

- A tree-based workflow engine with versioned models, drafts, publish/suspend/activate, start ranges and workflow administrators. Tree and BPMN designers coexist; supported BPMN diagrams compile to the same tree engine, with import/export and progress highlighting.
- Structured approver strategies covering users, roles, positions, departments, department leaders, initiators, initiator selection and form fields; any/all/sequential approval; exclusive, parallel and inclusive branches; department/role conditions and configurable empty-approver/rejection behavior.
- Approval, rejection, return/resubmission, transfer, delegation, pre/post add-sign, remove-sign, copy, withdraw, instance cancellation, comments and rate-limited reminders. Personal inboxes, instance timelines/printing, scoped instance administration, termination and reassignment are included, with an original leave-request example.
- Visual form design with JSON/Vue SFC export, business and dynamic form integration, field-access controls, attachment binding, a no-code approval wizard, built-in templates, approval data exports, server-computed day counts and detail totals.
- Timeout reminders and configured auto-approve/auto-reject/transfer-to-superior actions, recorded in the timeline and notifications. Timeout scanning uses natural hours and approximately five-minute scheduling precision under normal operation.

#### OAuth2 and SSO

- Confidential OAuth2 clients with authorization code + PKCE S256, refresh tokens and client credentials; authorization/consent, userinfo, introspection and revocation endpoints. Password and implicit grants are rejected.
- Client management with one-time secret display/reset, exact redirect matching, grant/scope validation, consent lifetimes and revocation when a client is disabled/deleted. The browser SSO entry supports consent, account switching and returning after login.

#### Optional employee mobile client

- An independent uni-app Vue 3 folder for employee login, workbench, workflow tasks/applications, inbox, bulletins and profiles, targeting WeChat mini-program, Android and iOS, with H5 builds for debugging. Desktop-only projects can remove it using the documented steps.
- Workflow actions and supported dynamic forms with field visibility/edit rules, a shared validation contract, server-side calculations and generated mobile CRUD examples.
- A consistent original visual system with brand assets, empty states, custom tab icons and light/dark themes; App/H5 appearance selection and mini-program system-following appearance.
- Realtime task/message refresh with reconnect and polling fallbacks, session-kick handling, opt-in WeChat subscription reminders and platform version/update checks. Native-device, real WeChat-send and store-release acceptance remains pending in the mobile release checklist.

### Security

- Shared Zod validation, parameterized SQL, permission/data-scope checks and transactional write locks guard reads, exports and writes. Soft-delete reference registration supports restrict/cascade behavior without database foreign keys.
- Session rotation, reuse detection, revocation, brute-force/IP controls, origin checks, password rules, Redis-backed throttling and idempotent create submissions are enabled by the relevant routes. Temporary Redis throttling failures return an error instead of allowing the request.
- Rich-text sanitization, form-schema behavior/function rejection, network/SSRF guards, upload magic/size/path validation, private-file ownership checks, Excel injection protection and restricted BPMN XML parsing are covered by security regressions.
- Production startup, migration and seed entry points reject secrets containing the case-insensitive `not-for-production` marker. Committed test administrator passwords carry that marker. This prevents fixture reuse; it does not certify arbitrary production passwords as strong.
- Demo mode rejects writes by default, with exact method/route exceptions for login, session maintenance, preferences and supported read markers. Its lock-screen failure threshold revokes only the current session, and audit/session responses and exports mask visitor network metadata while retaining the original stored evidence.
- Each instance rechecks the sessions of its local sockets every 60 seconds to recover from a lost disconnect broadcast. Production deployments must still satisfy the shared-state and proxy requirements in [scale-out.md](docs/scale-out.md).
- Dependency licensing, original identifier checks, strict localization and architecture checks run in the local gates. Production dependencies and third-party assets are documented in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

### Windows support

- Prepared native PowerShell 5.1 workflows through LF checkout rules, normalized paths, portable pnpm child-process calls, cross-platform golden comparisons, explicit guarded golden write-back, quoted CI commands, and serial-only Windows gates.
- Added PowerShell examples, `pnpm.cmd`/standalone `pnpm.exe` guidance and Windows-specific guards. Registered the approved sharp win32 license exceptions and checked the actual exception file and notice coverage in the license self-test.
- Native Windows 11 + Windows PowerShell 5.1 (including the cmd entry) is verified for development and the full local gate (`pnpm ci:local --serial`); symlink-protection tests skip without file-symlink privilege; server deployment and App / mini-program publishing on Windows are not verified. See the [Windows setup](docs/getting-started.md#windows原生-powershell-51).

### Known limitations

- Node 22 / pnpm 11.28.x are the runtime and package-manager baseline, with pnpm 11.28.3 pinned in both projects. See [the runtime decision](docs/adr/006-runtime-package-manager.md). pnpm 12 remains untested.
- The admin UI targets desktop browsers (1280–1920); drawer/dialog behavior on narrower screens does not constitute a mobile-admin product. The employee mobile client is separate, and native-device and publishing validation remains open. Some mobile dynamic form controls are read-only, and attachments show filenames without mobile open/download support.
- App offline push, permanent App sessions and single-App login are planned; basic chat and employee organization directory are planned after v1.0. Reserving names does not deliver those features. Audio/video calls are outside the first chat scope.
- Multi-tenancy is not implemented; the documented hooks and department scopes do not provide tenant isolation. The platform uses one MySQL data source, a monolithic service architecture and soft-delete reference rules, without PostgreSQL or database foreign keys.
- Multi-instance deployment requires Redis ≥ 7, identical deployment state/secrets, database-qualified channels, ready adapter subscriptions, a shared local storage volume or S3, and correctly configured WebSocket forwarding/`TRUST_PROXY`. Same-machine two-process tests do not validate multi-host routing, external storage, Redis failover or production capacity.
- Socket.IO sharded adapters do not support connection-state recovery or durable delivery. Reliable data must be stored and refetched via REST; broadcasts may be lost. RedisLock and shared throttling assume a single Redis node, session listings use one MGET followed by in-memory paging, and mail transports are cached per instance.
- BPMN is a supported structured modeling subset compiled to a tree, not a general BPMN execution engine. Loops, arbitrary routing/joins, scripts, expressions, listeners, subprocesses and unsupported elements are rejected. Timeout handling is not a strict real-time deadline service. The bpmn.io logo must remain visible, unmodified and unobscured, including with the optional application watermark.
- OAuth2 supports confidential clients only; public clients and OIDC are deferred. Demo installations block OAuth write endpoints and the realtime send demonstration; use a non-demo installation to exercise those flows.
- Generated numeric bigint inputs are limited to safe integers (`2^53 - 1`); default numeric decimal handling has a 15-significant-digit ceiling and cannot guarantee exact floating-point money arithmetic. Wider decimal/string paths and precision-sensitive businesses must follow the [codegen precision contract](docs/codegen.md#数值精度边界).
- External SMS/mail/S3/WeChat services and native App publishing need deployment-specific credentials and acceptance. PM2 is an optional globally installed operations tool, not a project dependency. Docker/compose and remote CI support are planned; real S3 deployment and browser behavior need validation in the target environment.
