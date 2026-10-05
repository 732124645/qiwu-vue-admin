// What the generator pages do with rendered code: download as a zip, write into the
// repository; shared by the list and the preview dialog.
import { ElMessage, ElMessageBox } from 'element-plus'
import { codegenApi } from '@/api/platform/codegen'
import { openDialog } from '@/core/dialog'
import { i18n } from '@/core/i18n'
import { ApiError } from '@/core/request/http'
import CodegenWriteResult from './write-result.vue'

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)

/** The request layer toasts 403/409/422/429/5xx; these calls also show the 400/404 it leaves to callers. */
function toastRest(e: unknown) {
  if (e instanceof ApiError && (e.status === 400 || e.status === 404)) ElMessage.error(e.message)
}

/** Saves the configs' files as one zip: `<table>.zip` for one, `codegen.zip` for several. */
export async function downloadZip(rows: { id: number; tableName: string }[]) {
  const name = rows.length === 1 ? rows[0]!.tableName : 'codegen'
  try {
    await codegenApi.download(
      rows.map((r) => r.id),
      `${name}.zip`,
    )
  } catch (e) {
    toastRest(e)
  }
}

/**
 * Asks, then writes the configs' files into the repository (development servers only) and shows the
 * outcome: the files written and the registration lines, or, when existing files differ, their diffs
 * (nothing was written then). Resolves true once the server answered.
 */
export async function writeConfigs(ids: number[]): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      t('codegen.table.write.confirm', { count: ids.length }),
      t('crud.confirm.title'),
      {
        type: 'warning',
        confirmButtonText: t('codegen.table.action.write'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return false
  }
  try {
    const result = await codegenApi.write(ids)
    void openDialog(
      CodegenWriteResult,
      { result },
      { title: () => t('codegen.table.write.title'), width: '1200px' },
    )
    return true
  } catch (e) {
    toastRest(e)
    return false
  }
}
