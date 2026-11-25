import type { MePayload } from '@qiwu/shared'

/** 办公审批依赖工作流套餐，缺少身份时不按默认租户的无限制状态处理。 */
export const officeWorkflowAvailable = (me: MePayload | null): boolean =>
  !!me && (me.features === undefined || me.features.includes('workflow'))
