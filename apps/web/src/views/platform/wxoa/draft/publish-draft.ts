import { ElMessage, ElMessageBox } from 'element-plus'
import type { WxoaPublishVo } from '@qiwu/shared'
import { wxoaPublishApi } from '@/api/platform/wxoa/publish'
import type { WxoaDraftVo } from '@/api/platform/wxoa/draft'
import { toastRest } from '@/core/composables/use-crud'
import { i18n } from '@/core/i18n'

/**
 * 二次确认后把一份已同步的草稿提交发布（草稿列表与发表记录页共用）。发布会公开推送给粉丝，
 * 所以先确认；取消或失败返回 undefined，成功返回新的发表记录。
 */
export async function publishDraft(
  accountId: number,
  draft: WxoaDraftVo,
): Promise<WxoaPublishVo | undefined> {
  const { t } = i18n.global
  try {
    await ElMessageBox.confirm(
      t('wxoa.publish.create.confirm', { title: draft.title }),
      t('wxoa.publish.create.title'),
      {
        type: 'warning',
        confirmButtonText: t('wxoa.publish.create.action'),
        cancelButtonText: t('common.action.cancel'),
      },
    )
  } catch {
    return undefined
  }
  try {
    const row = await wxoaPublishApi.create({ accountId, draftId: draft.id })
    ElMessage.success(t('wxoa.publish.create.done'))
    return row
  } catch (e) {
    toastRest(e)
    return undefined
  }
}
