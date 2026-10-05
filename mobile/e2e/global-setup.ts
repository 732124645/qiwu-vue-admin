// Runs after the web servers are up (the server command already reset qiwu_mobile_e2e): drops the previous
// run's `qw:*` keys from Redis db 9 (sign-in locks, sessions and caches outlive the database reset), and adds
// what the specs need to the fresh database: the SMS sign-in user and a `debug` SMS channel for the sign-in
// code templates (codes are read back from msg_sms_otp). The ACL user may not FLUSHDB/KEYS: SCAN + UNLINK.
import { USERS, serverScript } from './env'

const SCRIPT = `
import { createClient } from 'redis'
import { DataSource } from 'typeorm'
import { keyPattern } from './dist/core/redis/cache-namespaces.js'
import { dataSourceOptions } from './dist/db/data-source.js'
import { seedLimitedUser } from './dist/db/seeds/iam/iam.seed.js'
import { insertRow } from './dist/db/seeds/upsert.js'
const { REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_DB, SMS_USER } = process.env
const redis = createClient({
  socket: { host: REDIS_HOST, port: Number(REDIS_PORT) },
  username: REDIS_USERNAME,
  password: REDIS_PASSWORD,
  database: Number(REDIS_DB),
})
await redis.connect()
try {
  for await (const keys of redis.scanIterator({ MATCH: keyPattern(), COUNT: 500 }))
    if (keys.length) await redis.unlink(keys)
} finally {
  await redis.close()
}
const sms = JSON.parse(SMS_USER)
const ds = await new DataSource(dataSourceOptions()).initialize()
try {
  await ds.transaction(async (q) => {
    const userId = await seedLimitedUser(q, sms.username, sms.password)
    await q.query('UPDATE iam_user SET mobile = ? WHERE id = ?', [sms.mobile, userId])
    const channelId = await insertRow(q, 'msg_sms_channel', { driver: 'debug', name: 'mobile-e2e', enabled: 1 })
    await q.query('UPDATE msg_sms_template SET channel_id = ? WHERE code = ?', [channelId, 'auth.sms_code'])
  })
} finally {
  await ds.destroy()
}
`

export default function globalSetup() {
  serverScript(SCRIPT, { SMS_USER: JSON.stringify(USERS.sms) })
}
