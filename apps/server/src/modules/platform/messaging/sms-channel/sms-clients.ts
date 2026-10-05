import { randomUUID } from 'node:crypto'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { NET_TIMEOUT_MS } from '../../../../core/net/net-guard.js'
import { SmsChannel } from './sms-channel.entity.js'

export interface SmsMessage {
  mobile: string
  body: string
  templateId: string | null
  params: Record<string, string>
  paramOrder: string[]
}

export interface SmsClient {
  send(m: SmsMessage): Promise<{ providerMsgId: string | null }>
  test(): Promise<boolean>
}

type OpenChannel = SmsChannel & { apiSecret: string | null; receiptSecret: string | null }

@Injectable()
export class SmsClients {
  private readonly logger = new Logger(SmsClients.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly box: SecretBox,
  ) {}

  async for(channelId: number): Promise<SmsClient> {
    const row = await this.txHost.tx
      .getRepository(SmsChannel)
      .createQueryBuilder('s')
      .addSelect(['s.apiSecretEnc', 's.receiptSecretEnc'])
      .where('s.id = :id', { id: channelId })
      .getOne()
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new Error('SMS channel unavailable')
    return this.of({
      ...row,
      apiSecret: row.apiSecretEnc ? this.box.decrypt(row.apiSecretEnc) : null,
      receiptSecret: row.receiptSecretEnc ? this.box.decrypt(row.receiptSecretEnc) : null,
    })
  }

  of(row: OpenChannel): SmsClient {
    if (row.driver === 'debug')
      return {
        send: async (m) => {
          this.logger.log(`SMS debug ${m.mobile} ${m.body}`)
          return { providerMsgId: `debug-${randomUUID()}` }
        },
        test: async () => true,
      }

    const safe = async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action()
      } catch (error) {
        this.logger.warn(
          `SMS ${row.driver} failed: ${error instanceof Error ? error.name : 'Error'}`,
        )
        throw new Error('SMS provider failed')
      }
    }

    if (row.driver === 'aliyun') {
      const client = async () => {
        const sdk = (await import('@alicloud/dysmsapi20170525'))
          .default as unknown as typeof import('@alicloud/dysmsapi20170525')
        // The SDK accepts a Config-shaped object at runtime. Its Config type is in a transitive
        // dependency, so use the constructor's parameter type without importing that package.
        const config = {
          accessKeyId: row.apiKey!,
          accessKeySecret: row.apiSecret!,
          endpoint: 'dysmsapi.aliyuncs.com',
          regionId: row.region || 'cn-hangzhou',
          readTimeout: NET_TIMEOUT_MS,
          connectTimeout: NET_TIMEOUT_MS,
        } as ConstructorParameters<typeof sdk.default>[0]
        return { sdk, api: new sdk.default(config) }
      }
      return {
        send: (m) =>
          safe(async () => {
            const { sdk, api } = await client()
            const response = await api.sendSms(
              new sdk.SendSmsRequest({
                phoneNumbers: m.mobile,
                signName: row.signName!,
                templateCode: m.templateId!,
                templateParam: JSON.stringify(m.params),
              }),
            )
            if (response.body?.code !== 'OK') throw new Error('SmsProviderStatus')
            return { providerMsgId: response.body.bizId ?? null }
          }),
        test: () =>
          safe(async () => {
            const { sdk, api } = await client()
            const response = await api.querySmsSignList(
              new sdk.QuerySmsSignListRequest({ pageIndex: 1, pageSize: 1 }),
            )
            if (response.body?.code !== 'OK') throw new Error('SmsProviderStatus')
            return true
          }),
      }
    }

    if (row.driver === 'tencent') {
      const client = async () => {
        const sdk = (await import('tencentcloud-sdk-nodejs-sms'))
          .default as unknown as typeof import('tencentcloud-sdk-nodejs-sms')
        return new sdk.sms.v20210111.Client({
          credential: { secretId: row.apiKey!, secretKey: row.apiSecret! },
          region: row.region || 'ap-guangzhou',
          profile: { httpProfile: { reqTimeout: NET_TIMEOUT_MS / 1000 } },
        })
      }
      return {
        send: (m) =>
          safe(async () => {
            const response = await (
              await client()
            ).SendSms({
              PhoneNumberSet: [m.mobile.startsWith('+') ? m.mobile : `+86${m.mobile}`],
              SmsSdkAppId: row.appId!,
              SignName: row.signName!,
              TemplateId: m.templateId!,
              TemplateParamSet: m.paramOrder.map((key) => m.params[key] ?? ''),
            })
            const status = response.SendStatusSet?.[0]
            if (status?.Code !== 'Ok') throw new Error('SmsProviderStatus')
            return { providerMsgId: status.SerialNo ?? null }
          }),
        test: () =>
          safe(async () => {
            await (await client()).DescribeSmsSignList({ International: 0, Limit: 1, Offset: 0 })
            return true
          }),
      }
    }
    throw new Error('SMS channel driver unavailable')
  }

  async test(id: number): Promise<{ ok: boolean }> {
    try {
      return { ok: await (await this.for(id)).test() }
    } catch (error) {
      if (error instanceof NotFoundException) throw error
      this.logger.warn(
        `SMS channel ${id} test failed: ${error instanceof Error ? error.name : 'Error'}`,
      )
      return { ok: false }
    }
  }
}
