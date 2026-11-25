import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseEnv } from 'node:util'
import { envFiles } from '../paths.js'
import { EFFECTIVE_CONFIG_KEYS } from './env.schema.js'

/** 读取一个 env 文件；不存在或读不了按空文件处理（`.env.local` 本来就可以没有）。 */
function readEnvFile(file: string): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 检查 env 文件之间的同名键：前面的文件生效（`.env` 高于 `.env.local`），写在后面文件里的不同值会
 * 被静默忽略。读文件本身而不是 process.env（PM2 用 --env-file 时两份内容已合并进进程环境）。
 * 返回一条只含键名的提示（值可能是秘密，绝不输出）；没有冲突时返回 undefined。
 */
export function envFileConflicts(files: string[] = envFiles()): string | undefined {
  const [winner, ...others] = files
  if (!winner) return undefined
  const top = readEnvFile(winner)
  const parts = others.flatMap((file) => {
    const env = readEnvFile(file)
    const keys = Object.keys(env)
      .filter((k) => k in top && top[k] !== env[k])
      .sort()
    return keys.length
      ? [
          `keys defined in both ${basename(winner)} and ${basename(file)}, ${basename(winner)} wins: ${keys.join(', ')}`,
        ]
      : []
  })
  return parts.length ? `env: ${parts.join('; ')}` : undefined
}

/**
 * 启动后输出的一行生效配置（只含 `EFFECTIVE_CONFIG_KEYS` 列出的非秘密键），便于核对每个
 * worker 实际用了什么值。`get` 取校验后的配置，取不到的键（如 NODE_APP_INSTANCE）读进程环境，
 * 两边都没有的键不输出。
 */
export function effectiveConfigLine(
  get: (key: string) => unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pairs = EFFECTIVE_CONFIG_KEYS.flatMap((key) => {
    const value = get(key) ?? env[key]
    return value === undefined ? [] : [`${key}=${String(value)}`]
  })
  return `effective config: ${pairs.join(' ')}`
}
