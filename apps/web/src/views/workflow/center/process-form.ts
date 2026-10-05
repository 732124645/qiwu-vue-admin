import { sanitizeFormSchema, type FormSchema, type WfFieldAccess } from '@qiwu/shared'
import formCreate from '@/views/platform/formkit/widgets'

/** form-create's renderer with our `qw-*` components (widgets.ts registers them on it). */
export const FormCreate = formCreate.$form()

/** What the pages call on the renderer's api (`v-model:api`). */
export interface ProcessFormApi {
  /** resolves once every rule's checks pass, rejects otherwise (the messages show at the fields) */
  validate(): Promise<unknown>
}

/**
 * A dynamic process form as the browser renders it (see docs/design-notes.md#workflow): the schema through the same
 * `sanitizeFormSchema` as on save once more (null when it fails: nothing renders), without form-create's own
 * buttons. With `access` (the instance detail, values from the server) every rule loses its default value, a
 * `hide` one is dropped (the server sends neither it nor its value) and one the reader may not `edit` is
 * disabled, without its checks; without it (the start page) every rule is filled in.
 */
export function processForm(schema: unknown, access?: WfFieldAccess): FormSchema | null {
  const r = sanitizeFormSchema(schema)
  if (!r.ok) return null
  const rule = !access
    ? r.schema.rule
    : r.schema.rule
        .filter((x) => access[x.field] !== 'hide')
        .map((x) =>
          access[x.field] === 'edit'
            ? { ...x, value: undefined }
            : {
                ...x,
                value: undefined,
                $required: false,
                validate: undefined,
                props: { ...x.props, disabled: true },
              },
        )
  return { rule, option: { ...r.schema.option, submitBtn: false, resetBtn: false } }
}

/** The values of the fields `access` lets the reader edit: what an approval or a resubmit sends. */
export const editableValues = (values: Record<string, unknown>, access: WfFieldAccess) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => access[k] === 'edit'))
