// Vitest setupFiles（在 load-env.ts 之后）：限流按客户端 IP 计数，而所有测试都从 127.0.0.1 发请求，
// 上一个文件在同一分钟里用掉的额度会让下一个文件无端收到 429。每个文件开始前清空限流计数，
// 需要验证限流的测试在自己的文件里照常把额度用满。
import { createClient } from 'redis'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'

beforeAll(async () => {
  const redis = createClient({
    socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) },
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    database: Number(process.env.REDIS_DB),
  })
  await redis.connect()
  try {
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 500 }))
      if (keys.length) await redis.unlink(keys)
  } finally {
    await redis.close()
  }
})
