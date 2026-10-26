import pino from 'pino'
import type { AppConfigService } from '../../src/core/config/config.module.js'
import { pinoHttpOptions } from '../../src/core/logger/logger.module.js'

/** 用真实日志器验证按级别和运行模式降噪，不依赖终端文本过滤。 */
function capture(mode: string) {
  const lines: string[] = []
  const cfg = {
    get: (key: string) => (key === 'NODE_ENV' ? mode : 'debug'),
  } as AppConfigService
  const options = pinoHttpOptions(cfg)
  const logger = pino({ ...options, transport: undefined }, { write: (line) => lines.push(line) })
  return { logger, lines, options }
}

afterEach(() => vi.unstubAllEnvs())

it('development reload hides only repeated framework info and keeps warnings, errors and business logs', () => {
  vi.stubEnv('QW_DEV', '1')
  const { logger, lines } = capture('development')
  for (const context of [
    'NestFactory',
    'InstanceLoader',
    'RoutesResolver',
    'RouterExplorer',
    'NestApplication',
  ]) {
    logger.info({ context }, 'registered')
    logger.warn({ context }, 'warning retained')
    logger.error({ context }, 'error retained')
  }
  logger.info({ context: 'InventoryService' }, 'business info retained')
  logger.debug({ context: 'InventoryService' }, 'business debug retained')
  logger.error(new Error('import failed; token=SECRET-LOG-PROBE'))
  const data = lines.map((line) => JSON.parse(line) as { msg: string })
  expect(data.filter(({ msg }) => msg === 'registered')).toHaveLength(0)
  expect(data.filter(({ msg }) => msg === 'warning retained')).toHaveLength(5)
  expect(data.filter(({ msg }) => msg === 'error retained')).toHaveLength(5)
  expect(data.map(({ msg }) => msg)).toContain('business info retained')
  expect(data.map(({ msg }) => msg)).toContain('business debug retained')
  expect(lines.join('')).not.toContain('SECRET-LOG-PROBE')
})

it('production and standalone development keep framework information', () => {
  vi.stubEnv('QW_DEV', '1')
  const production = capture('production')
  production.logger.info({ context: 'RouterExplorer' }, 'registered in production')
  expect(production.lines).toHaveLength(1)
  expect(production.options.transport).toBeUndefined()
  vi.stubEnv('QW_DEV', '')
  const standalone = capture('development')
  standalone.logger.info({ context: 'RouterExplorer' }, 'registered outside dev loop')
  expect(standalone.lines).toHaveLength(1)
})

it('development output is compact while its structured serializers remain masked', () => {
  vi.stubEnv('QW_DEV', '1')
  const { options } = capture('development')
  expect(options.transport).toMatchObject({
    target: 'pino-pretty',
    options: { singleLine: true },
  })
  const serialize = options.serializers!.req!
  expect(
    serialize({ id: 'req-1', method: 'GET', url: '/api/example?token=SECRET', headers: {} }),
  ).toMatchObject({
    id: 'req-1',
    method: 'GET',
    url: '/api/example?token=***',
  })
})
