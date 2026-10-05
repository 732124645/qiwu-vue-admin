// Compiled Nest only: no tsx/type stripping, no reset, no HTTP test routes.
import { textRedactor } from '../../../dist/core/redact.js'

let app
let stopping = false
const hardStop = setTimeout(() => process.exit(1), 180_000)

async function stop(code = 0) {
  if (stopping) return
  stopping = true
  const force = setTimeout(() => process.exit(1), 5_000)
  try {
    await app?.close()
  } finally {
    clearTimeout(force)
    clearTimeout(hardStop)
    process.exit(code)
  }
}

process.on('message', (message) => {
  if (message === 'stop') void stop()
})
process.once('disconnect', () => void stop())
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())

try {
  await import('reflect-metadata')
  const { NestFactory } = await import('@nestjs/core')
  const { AppModule } = await import('../../../dist/app.module.js')
  const { setupApp } = await import('../../../dist/app.setup.js')
  app = setupApp(await NestFactory.create(AppModule, { logger: false, abortOnError: false }))
  if (stopping) await app.close()
  else {
    await app.listen(0, '127.0.0.1')
    if (!stopping) process.send?.({ url: `http://127.0.0.1:${app.getHttpServer().address().port}` })
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${textRedactor(process.env)(message).slice(0, 2000)}\n`)
  process.send?.({ error: 'Multi-instance runner failed to start' })
  await stop(1)
}
