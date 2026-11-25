import {
  formUploadIds,
  storageRefs,
  type FormSchema,
  type FsObjectVo,
  type WfFieldAccess,
} from '@qiwu/shared'
import {
  decide,
  decisionAllowed,
  detailActions,
  type WfDecision,
  type WfOn,
} from '@/core/approvals'
import { attachmentPreviewable, loadAttachments } from '@/core/attachments'
import { currentSessionVersion } from '@/core/request'
import { decisionFormRules } from '../form/process-form'

/** 详情动作栏与实际提交使用同一可读性策略。 */
export const availableActions = (instance: Parameters<typeof detailActions>[0], ready: boolean) =>
  detailActions(instance).filter((item) => decisionAllowed(item.action, ready))

/** 弹层提交时再次检查当前状态，冲突先关闭旧弹层再让详情重新读取。 */
export async function submitDecision(input: {
  on: WfOn
  ready: boolean
  body: () => object | null | undefined
  unavailable: () => void
  close: () => void
  done: () => void
  conflict: () => void
}) {
  if (!decisionAllowed(input.on.action, input.ready)) {
    input.unavailable()
    return
  }
  const body = input.body()
  if (!body) return
  await decide(input.on.id, input.on.action as WfDecision, body, () => {
    input.close()
    input.conflict()
  })
  input.close()
  input.done()
}

/** 当前可见附件变动即阻塞审批；迟到批次与旧身份结果不能恢复可读状态。 */
export function dynamicAttachmentsController(
  changed: (files: FsObjectVo[], ready: boolean) => void,
) {
  let sequence = 0
  return {
    invalidate() {
      sequence++
      changed([], false)
    },
    async refresh(
      schema: FormSchema | null,
      access: WfFieldAccess,
      values: Record<string, unknown>,
    ) {
      const mine = ++sequence
      const session = currentSessionVersion()
      changed([], false)
      const rules = schema === null ? [] : decisionFormRules(schema, access)
      if (
        !rules ||
        rules.some((rule) => rule.type === 'qw-upload' && storageRefs(values[rule.field]) === null)
      )
        return
      try {
        const files = await loadAttachments(formUploadIds(rules, values), 'wf.attachment')
        if (mine === sequence && session === currentSessionVersion())
          changed(files, files.every(attachmentPreviewable))
      } catch {
        // 保留阻塞状态，用户可移除不可读文件或重新载入。
      }
    },
  }
}
