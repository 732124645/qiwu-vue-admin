import {
  AGENT_LIMIT_PARAMS,
  type AgentProviderVo,
  type AgentSearchProviderVo,
  type ParameterVo,
} from '@qiwu/shared'

export type GuideKey = 'providers' | 'search' | 'tools' | 'chat'
export interface GuideStep {
  key: GuideKey
  optional: boolean
  done: boolean
}
/** 本浏览器里记下的引导进度：看过工具审批、去过对话页、是否收起 */
export interface GuideMemo {
  tools?: boolean
  chat?: boolean
  collapsed?: boolean
}

/**
 * “开始使用”的四步与完成情况：有一个启用且带模型的模型服务就算配好模型（与运行时取模型一致：没标默认时
 * 取排在最前的启用者）；联网搜索可选，有启用的
 * 搜索服务即算完成；工具审批和试用对话没有接口状态可查，按本浏览器是否打开过记录。
 */
export function guideSteps(
  providers: Pick<AgentProviderVo, 'enabled' | 'models'>[],
  searches: Pick<AgentSearchProviderVo, 'enabled'>[],
  memo: GuideMemo,
): GuideStep[] {
  return [
    {
      key: 'providers',
      optional: false,
      done: providers.some((p) => p.enabled && p.models.length > 0),
    },
    { key: 'search', optional: true, done: searches.some((s) => s.enabled) },
    { key: 'tools', optional: false, done: !!memo.tools },
    { key: 'chat', optional: false, done: !!memo.chat },
  ]
}

/** 启用的模型服务里没配费率的模型显示名：它们照常可用，但调用记为未计价、不计入积分额度。 */
export const unpricedModels = (providers: Pick<AgentProviderVo, 'enabled' | 'models'>[]) =>
  providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.filter((m) => !m.pricing).map((m) => m.label || m.id))

const CREDIT_LIMITS = [
  AGENT_LIMIT_PARAMS.turnCredits,
  AGENT_LIMIT_PARAMS.userDailyCredits,
  AGENT_LIMIT_PARAMS.tenantDailyCredits,
]
/**
 * 三个积分额度都是 0（不限）：升级前的 token 上限没法换算成积分，升级后会落到这里，要显眼提示。
 * 参数还没载入（空对象）时不算，免得一闪而过的误报。
 */
export const noCreditCap = (params: Record<string, Pick<ParameterVo, 'paramValue'>>) =>
  Object.keys(params).length > 0 &&
  CREDIT_LIMITS.every((key) => !(Number(params[key]?.paramValue) > 0))

/** 必需的步骤都完成了（可选步骤不影响），这时才允许收起引导。 */
export const guideComplete = (steps: GuideStep[]) => steps.every((s) => s.optional || s.done)

/** 每个用户在本浏览器里一份进度 */
export const guideStorageKey = (userId: number | undefined) => `qw.agent.setup-guide.${userId ?? 0}`

/** 读进度；无痕模式、存储被禁用或内容损坏时当作没有记录。 */
export function readGuide(key: string): GuideMemo {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value && typeof value === 'object' ? (value as GuideMemo) : {}
  } catch {
    return {}
  }
}

/** 写进度；存储不可用时静默放弃，引导下次仍会显示。 */
export function writeGuide(key: string, memo: GuideMemo) {
  try {
    localStorage.setItem(key, JSON.stringify(memo))
  } catch {
    // 存储不可用：只影响引导是否记得进度
  }
}
