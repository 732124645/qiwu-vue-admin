import { Inject, Injectable, Optional } from '@nestjs/common'
import { type AgentItemPayloads, Err } from '@qiwu/shared'
import type { z } from 'zod'
import {
  AgentBuiltinTool,
  type AgentToolContext,
  SKILL_SOURCE,
  type SkillSource,
} from '../agent-ports.js'
import { ASK_TOOL, askInput, PLAN_TOOL, planInput, SKILL_TOOL, skillInput } from './turn-tools.js'

/**
 * 运行时自带的内置工具：计划清单、反问用户、加载技能（后者只在有技能来源时提供）。与别的模块的内置工具
 * 一样经 `@AgentBuiltinTool` 登记（see docs/agent.md）。
 */
@Injectable()
export class AgentCoreTools {
  constructor(@Optional() @Inject(SKILL_SOURCE) readonly skills?: SkillSource) {}

  /** 计划清单：本轮一份，第一次追加、之后原地替换。 */
  @AgentBuiltinTool({
    name: PLAN_TOOL,
    title: 'Update the plan',
    description:
      'Replaces the checklist of this task shown to the user: every step with its status ' +
      '(pending, doing, done). Call it when you start a multi-step task and whenever a step changes.',
    kind: 'read',
    input: planInput,
  })
  async plan({ steps }: z.output<typeof planInput>, ctx: AgentToolContext) {
    const plan: AgentItemPayloads['plan'] = { steps }
    const last = ctx.items.list('plan').at(-1)
    if (last) await ctx.items.replace(last.id, plan)
    else await ctx.items.add('plan', plan)
    return { ok: true, content: 'Plan updated.' }
  }

  /** 反问用户：问题卡出来后本轮停下，回答作为这次调用的结果交给模型。 */
  @AgentBuiltinTool({
    name: ASK_TOOL,
    title: 'Ask the user',
    description:
      'Asks the user 1-4 questions, each with 2-4 options (single or multiple choice; the user may also ' +
      'type an answer), and waits for the answers. Use it when a choice is the user’s to make.',
    kind: 'read',
    input: askInput,
  })
  ask({ questions }: z.output<typeof askInput>, ctx: AgentToolContext) {
    return ctx.ask(questions)
  }

  /**
   * 加载技能：按名字取发起人可用的技能正文（没有技能来源时不提供）。自动化的会话里只取本人的个人技能与平台
   * 技能：别人能改的全租户技能（哪怕同名遮住了平台的）不交给没人实时看着的运行。
   */
  @AgentBuiltinTool({
    name: SKILL_TOOL,
    title: 'Load a skill',
    description:
      'Returns the instructions of one of the listed skills by name. Load a skill before doing a ' +
      'task it describes.',
    kind: 'read',
    input: skillInput,
    available: (_ctx, self) => (self as AgentCoreTools).skills !== undefined,
  })
  async skill({ name }: z.output<typeof skillInput>, ctx: AgentToolContext) {
    const found = await this.skills?.load(ctx.principal, name, {
      noTenant: ctx.thread.automationRunId !== null,
    })
    if (!found) return ctx.fail(Err.NOT_FOUND, `no skill named ${name}`)
    return {
      ok: true,
      content: `Skill ${found.name}${found.tools ? ` (tools: ${found.tools.join(', ')})` : ''}:\n${found.body}`,
    }
  }
}
