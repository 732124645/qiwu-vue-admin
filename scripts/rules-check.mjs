#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceName = ['AGENTS', 'md'].join('.')
const entryName = `${['CLAU', 'DE'].join('')}.${'md'}`
// the other coding tools' entry points: each only sends the tool to the rule body
const pointers = ['.cursor/rules/qiwu.mdc', '.github/copilot-instructions.md']
const stat = (path) => {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
const regular = (s) => s.isFile() && !s.isSymbolicLink()

/**
 * 检查一个目录里的规则正文与入口：正文和导入入口成对出现、都是普通文件、入口只有一行导入；
 * 其他工具的入口文件存在时必须指向正文。`complete` 时（公开 AI 文件源）所有入口都必须存在。
 */
function checkRules(dir, label, complete) {
  const sourceStat = stat(join(dir, sourceName))
  const entryStat = stat(join(dir, entryName))
  if (!sourceStat && !entryStat && !complete) return false
  if (!sourceStat || !entryStat)
    throw new Error(
      `rules: ${label}: the canonical rule body and its paired entry point must be present together`,
    )
  if (!regular(sourceStat) || !regular(entryStat))
    throw new Error(`rules: ${label}: both rule entry points must be regular files`)
  const entry = readFileSync(join(dir, entryName), 'utf8').replaceAll('\r\n', '\n')
  if (entry !== `@${sourceName}\n`)
    throw new Error(
      `rules: ${label}: the paired entry point must import the canonical rule body without extra text`,
    )
  if (!readFileSync(join(dir, sourceName), 'utf8').trim())
    throw new Error(`rules: ${label}: the canonical rule body is empty`)
  for (const pointer of pointers) {
    const s = stat(join(dir, pointer))
    if (!s && !complete) continue
    if (!s || !regular(s))
      throw new Error(
        `rules: ${label}: ${pointer} must be a regular file pointing at the rule body`,
      )
    if (!readFileSync(join(dir, pointer), 'utf8').includes(sourceName))
      throw new Error(`rules: ${label}: ${pointer} must send the tool to the rule body`)
  }
  return true
}

const own = checkRules(root, 'repository', false)
// the private source of the public snapshot's agent files (exported to the snapshot root)
const aiSource = stat(join(root, 'public-ai'))
if (aiSource && (!aiSource.isDirectory() || aiSource.isSymbolicLink()))
  throw new Error('rules: public-ai must be a regular directory')
const published = aiSource && checkRules(join(root, 'public-ai'), 'public-ai', true)
console.log(
  own || published
    ? 'rules: canonical body and paired entry points are synchronized'
    : 'rules: snapshot has no agent entry points',
)
