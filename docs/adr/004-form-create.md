# ADR-004 — form-create designer without wangeditor

- Status: accepted
- Date: 2026-09-26

## Context and decision

Use `@form-create/designer` and `@form-create/element-ui` for form design and rendering. The designer's published dist bundle inlines the old wangeditor implementation, even when the dependency graph no longer contains it. Dependency-tree checks alone therefore do not establish that the application bundle excludes that code. wangeditor v4 is no longer maintained, has an unfixed XSS vulnerability (GHSA-g7mw-5cq6-fv82), and is explicitly banned by `license:check`.

Build the designer from its published source with an exact Vite alias for `@form-create/designer`. Alias `@form-create/component-wangeditor` to the local disabled `fcEditor` stub at `apps/web/src/stubs/fc-wangeditor.ts`, and remove the old dependency through the `readPackage` hook in the root `.pnpmfile.cjs`. Vitest inherits the same aliases. Keep `blockExoticSubdeps` enabled.

## Technical findings and consequences

- The integration check confirmed the registered editor component is the stub; removing either alias fails this contract. A source-based build excluded the inlined editor and was smaller than the dist-based build.
- Import the bare designer package and its source locale modules; never import its dist entry. An upgrade must preserve the separate rich-text import and compatible source dependency paths.
- Hide rich text, raw HTML, the form-create AI panel and editors that compile function strings. Dynamic schemas use a strict whitelist on both server and browser; CSP remains `script-src 'self'`.
- Building from source includes the designer CSS and icon font. Scope its icon selectors so they do not change unrelated application buttons.
- Production checks inspect emitted chunk content as well as component identity, because module IDs alone cannot reveal an inlined dependency. No old-editor license or vulnerability exception is required.

The following integration details describe the supported form behavior. See [validation design](../design-notes.md#validation) and [workflow design](../design-notes.md#workflow).

## Designer under the SPA CSP

`apps/web/src/views/platform/formkit/FormDesigner.vue` mounts the designer in the built app, and
`e2e/fc-designer-csp.spec.ts` runs it under `vite preview` with `SPA_CSP`. The spec adds an input and a select,
opens both settings tabs, and sees no CSP violation, console CSP error or page error. The fallback is not
needed. Regression checks: with `showJsonPreview` turned back on, editing the JSON fails the spec with
`script-src blocked eval`; with `showEventForm` back on, the event panel renders.

- Hidden editors, because each runs user input through `new Function`: the component events
  (`showEventForm`), control rules (`showControl`), custom props (`showCustomProps`), the JSON module
  (`showJsonPreview`), the validator list (`validateOnlyRequired`, whose list offers a function validator), form
  events (`hiddenFormConfig: ['formCreate_event']`), function props, and the JSON/fetch options editors
  (`hiddenItemConfig.default`, which includes `_optionType`). `showAi: false` and `hiddenItem: ['fcEditor']` are
  configured for this integration.
- `vite.config.ts`: unplugin-vue-components also transforms the designer's `.vue` sources, so their `<el-*>`
  tags import Element Plus on demand. `@form-create/element-ui/auto-import` registers the components the
  renderer resolves by name.
- `vite.config.ts`: a PostCSS rule limits the designer's `icon.css` to `.fc-icon.icon-*`. Its bare
  `.icon-button:before` gave our `IconButton` a glyph once the designer chunk had loaded.

## Form builder and locale

`views/platform/formkit/index.vue` (menu `formkit-design` under 系统工具, no keep-alive: the designer's hotkeys
listen on the document while it is mounted) holds the designer. Its `locale` prop follows `setLocale` through
`formLocale` (`core/i18n`), and the designer hands the name on to its own renderers (settings panels, preview).
The texts come from `@form-create/designer/src/locale/*.js`, the source the designer is built from: the
published `locale/*` files are a 3.4.0 build that lacks about 30 keys of 3.5.0. A renderer of our own takes
`:locale="formLocale"` (its validation messages). `hiddenItem` also lists `html` (raw HTML through `v-html`,
a component excluded by the form-schema whitelist).

## Application components

`views/platform/formkit/widgets.ts` registers `qw-user-select`, `qw-dept-select`, `qw-dict-select`, `qw-upload`
and `qw-area-select` on form-create itself (`formCreate.component`), so the designer's preview and every
renderer that imports the module have them. Each wraps the existing picker (UserSelect with the `wf` user
source, DeptTreeSelect, DictSelect, FileUpload, AreaCascader) and takes form-create's `formCreateInject` prop,
which would otherwise reach the DOM as an attribute. FormDesigner adds them to the designer's canvas
(`FcDesigner.component`) and, through `addMenu`/`addDragRule`, to a group of their own in the component list,
named from the app's locale files (`formkit.widget.*`, merged into the designer's locale object). Their
settings offer only props that `sanitizeFormSchema` keeps; a `qw-dict-select` picks its dict from
`GET /api/settings/dicts/options`.

Values: the user and dept id, the dict entry code (codes with `multiple`), the area code path, and for
`qw-upload` one `<id>/<file name>` string per file (`fileRef`, the text-column format of generated forms).
No URL or other field of the stored object enters the form data, so a value someone else typed cannot become
a link for the approver; the files are private `wf.attachment` objects that the workflow service binds to the instance
on start, and `maxSize` is in MB. `formkit-widgets.spec.ts` builds a form of the five, checks the rule the
designer exports against `sanitizeFormSchema`, and fills it in the preview.

## Schema function strings and the built bundle

- `apps/web/src/__tests__/form-schema-parsefn.spec.ts` checks `sanitizeFormSchema` against form-create's own
  `parseFn`. Every prefix it compiles (`$FN:`, `$FNX:`, `$EXEC:`, `$GLOBAL:`, `[[FORM-CREATE-PREFIX-`,
  `function …`) is rejected, including behind each of the leading blanks that `String#trim` strips. The
  string evaluators in `@form-create/core` (`computed`, `control`, and the validate `computed` mode) can only
  be reached through keys that the whitelist forbids. The shared schema tests cover these keys.
- `scripts/arch/web-bundle.mjs` scans `apps/web/dist/**/*.js` after a build. `ci:local` runs it right after
  its build step, and the full arch run skips it when there is no dist. It fails on two things:
  - wangeditor v4 code. The check matches v4-only config keys such as `uploadImgServer` and
    `onchangeTimeout`, because `@wangeditor-next` (`<RichEditor>`) also prints `wangEditor`, so a
    `wangEditor` grep no longer works.
  - `eval(` or `Function(` calls outside a short allow-list: the global-object fallback in lodash and similar libraries, zod's
    eval probe, and form-create's `parseFn`, `compileFn` and designer editors.

  Regression check: with the designer alias removed, the build fails the check on `onchangeTimeout` and
  on three core-js `Function(` calls. Self-test: `node scripts/arch/web-bundle.mjs --self-test`.

## Process forms

`views/workflow/center/process-form.ts` renders a version's form on the start dialog and the instance detail
through `formCreate.$form()`, after `sanitizeFormSchema` once more. A page that renders it calls
`installFormCreate()`: the auto-import registers the Element Plus components the renderer resolves by name
(`el-form`, `el-input`, …) only when form-create is installed on the app. On the detail the server drops the
caller's `hide` fields (rule and value); `read` rules render disabled without their checks, and the `edit`
values go with an approval or a resubmit. A `qw-upload` value is one `<object id>/<file name>` line per file
(`storageRefs`), the string the server binds on start.

## Calculated components

`qw-date-range-days` and `qw-detail-table` sit in a second group of the component list (计算组件). Their
results come from fixed rules in `@qiwu/shared` `form-calc.ts`, with no formulas and no eval. The browser
shows these results. The server recomputes them with the same code on start (`WfStartService`) and on every
edit of the values (approve, resubmit: the engine reads `ctx.schema`, the version's sanitized schema). It
overwrites what the client sent, so forks branch on the server's numbers.

- `qw-date-range-days` (field: a `number`): it names the start and end `datePicker` fields
  (`startField`/`endField`). It may also name two AM/PM fields (`startHalfField`/`endHalfField`, any rule;
  the values `am`/`pm`). The result is the calendar days with both ends counted. An afternoon start or a
  morning end counts half. The result is null when a date is missing or the end comes first.
  `sanitizeFormSchema` rejects names that point nowhere (`calc_ref`).
- `qw-detail-table` (field: a `string`): its value is the rows as JSON text (the same idea as `qw-upload`'s
  text value). `columns: [{ prop, label?, sum? }]`. A column with `sum` holds numbers, and its total goes
  to the field `sum` names (a `number` field that `fieldsFromFormSchema` adds; a name that is already taken
  is a `duplicate_field`). The other columns hold text. The server stores the normalized rows: the declared
  cells only, at most 100 rows, rows left empty dropped.
