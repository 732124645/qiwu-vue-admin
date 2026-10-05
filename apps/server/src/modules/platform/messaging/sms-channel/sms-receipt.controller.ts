import { createHash, timingSafeEqual } from 'node:crypto'
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Err } from '@qiwu/shared'
import type { Response } from 'express'
import { z } from 'zod'
import { SkipActionLog } from '../../../../core/audit/action-log.js'
import { Public } from '../../../../core/auth/decorators.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { RateLimit } from '../../../../core/guard/rate-limit.decorator.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { SmsRecord } from '../sms-record/sms-record.entity.js'
import { SmsChannel } from './sms-channel.entity.js'

const id = z.string().min(1).max(128)
const shanghaiTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value.replace(' ', 'T')}+08:00`)
    return (
      !Number.isNaN(date.getTime()) &&
      new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) ===
        value.replace(' ', 'T')
    )
  })
const schemas = {
  debug: z
    .array(
      z.object({
        providerMsgId: id,
        status: z.enum(['delivered', 'failed']),
        at: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .max(100),
  aliyun: z
    .array(
      z.object({
        biz_id: id,
        success: z.boolean(),
        report_time: shanghaiTime.optional(),
        err_code: z.string().max(128).optional(),
      }),
    )
    .max(100),
  tencent: z
    .array(
      z.object({
        sid: id,
        report_status: z.enum(['SUCCESS', 'FAIL']),
        user_receive_time: shanghaiTime.optional(),
        errmsg: z.string().max(500).optional(),
      }),
    )
    .max(100),
} as const

@ApiTags('messaging')
@Controller('messaging/sms/receipt')
export class SmsReceiptController {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly box: SecretBox,
  ) {}

  @Post(':channel')
  @HttpCode(200)
  @Public()
  // Provider machine traffic has no user identity or business action to audit.
  @SkipActionLog()
  @RateLimit(120, 60_000)
  @ApiOperation({ summary: 'Accept authenticated SMS delivery receipts' })
  async receive(
    @Param('channel', ParseIntPipe) channelId: number,
    @Query('token') token: unknown,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const row = await this.txHost.tx
      .getRepository(SmsChannel)
      .createQueryBuilder('s')
      .addSelect('s.receiptSecretEnc')
      .where('s.id = :id AND s.enabled = :enabled', { id: channelId, enabled: true })
      .getOne()
    let secret: string | null = null
    try {
      if (row?.receiptSecretEnc) secret = this.box.decrypt(row.receiptSecretEnc)
    } catch {
      // All unavailable credentials answer exactly like an unknown channel.
    }
    if (
      !secret ||
      typeof token !== 'string' ||
      token.length > 512 ||
      !timingSafeEqual(
        createHash('sha256').update(token).digest(),
        createHash('sha256').update(secret).digest(),
      )
    )
      throw new BizError(Err.NOT_FOUND)

    const driver = row!.driver as keyof typeof schemas
    const parsed = schemas[driver]?.safeParse(body)
    if (!parsed?.success) throw new BadRequestException()
    const updates: { providerMsgId: string; status: 'delivered' | 'failed'; receiptAt: Date }[] = []
    for (const item of parsed.data) {
      const providerMsgId =
        driver === 'debug'
          ? (item as z.infer<typeof schemas.debug>[number]).providerMsgId
          : driver === 'aliyun'
            ? (item as z.infer<typeof schemas.aliyun>[number]).biz_id
            : (item as z.infer<typeof schemas.tencent>[number]).sid
      const status =
        driver === 'debug'
          ? (item as z.infer<typeof schemas.debug>[number]).status
          : driver === 'aliyun'
            ? (item as z.infer<typeof schemas.aliyun>[number]).success
              ? 'delivered'
              : 'failed'
            : (item as z.infer<typeof schemas.tencent>[number]).report_status === 'SUCCESS'
              ? 'delivered'
              : 'failed'
      const time =
        driver === 'debug'
          ? (item as z.infer<typeof schemas.debug>[number]).at
          : driver === 'aliyun'
            ? (item as z.infer<typeof schemas.aliyun>[number]).report_time
            : (item as z.infer<typeof schemas.tencent>[number]).user_receive_time
      const receiptAt = time
        ? new Date(driver === 'debug' ? time : `${time.replace(' ', 'T')}+08:00`)
        : new Date()
      if (Number.isNaN(receiptAt.getTime())) throw new BadRequestException()
      updates.push({ providerMsgId, status, receiptAt })
    }
    for (const { providerMsgId, status, receiptAt } of updates) {
      await this.txHost.tx
        .getRepository(SmsRecord)
        .createQueryBuilder()
        .update()
        .set({ receiptStatus: status, receiptAt })
        .where('channel_id = :channelId AND provider_msg_id = :providerMsgId', {
          channelId,
          providerMsgId,
        })
        .execute()
    }
    response.json(
      driver === 'tencent'
        ? { result: 0, errmsg: 'OK' }
        : { code: 0, msg: driver === 'aliyun' ? 'OK' : 'ok' },
    )
  }
}
