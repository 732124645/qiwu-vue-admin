import { applyDecorators, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common'
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { SkipActionLog } from '../../../../core/audit/action-log.js'
import { SkipHttpTrace } from '../../../../core/audit/http-trace.js'
import { Public } from '../../../../core/auth/decorators.js'
import {
  WXOA_PUSH_MAX_BYTES,
  type WxoaAnswer,
  type WxoaBody,
  WxoaCallbackService,
  type WxoaPushQuery,
} from './callback.service.js'

/**
 * The body of `req`, read here (the global parsers leave XML alone): null as soon as it passes `max`
 * bytes (the rest is drained by the server after the answer), 'consumed' when a global parser already
 * read it (a JSON or form content type).
 */
function readBody(req: Request, max: number): Promise<WxoaBody> {
  if (req.readableEnded || req.body !== undefined) return Promise.resolve('consumed')
  if (Number(req.headers['content-length']) > max) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) return void chunks.push(chunk)
      req.off('data', onData)
      resolve(null)
    }
    req.on('data', onData)
    req.once('end', () => resolve(Buffer.concat(chunks)))
    req.once('error', reject)
  })
}

/**
 * Swagger of both methods: the path key, the signature query (`signed`: always required) and the
 * failure answers; `params` are the method's own queries, optional unless marked required.
 */
const ApiPush = (
  signed: boolean,
  ...params: [name: string, description: string, required?: boolean][]
) =>
  applyDecorators(
    ApiParam({ name: 'key', description: "The account's callback key (22 characters, base64url)" }),
    ApiQuery({
      name: 'signature',
      required: signed,
      description: 'sha1 of token, timestamp, nonce',
    }),
    ApiQuery({ name: 'timestamp', description: 'Unix seconds, within 300 s of the server' }),
    ApiQuery({ name: 'nonce' }),
    ...params.map(([name, description, required = false]) =>
      ApiQuery({ name, required, description }),
    ),
    ApiResponse({
      status: 404,
      description:
        'Unknown key, disabled or deleted account, timestamp out of the window, a failed signature, ' +
        'nonce or decryption check (no body)',
    }),
    ApiResponse({
      status: 429,
      description: 'Over 120 failed checks within 60 s from this IP for this account (no body)',
    }),
  )

function send(res: Response, answer: WxoaAnswer): void {
  if (answer.body === undefined) res.status(answer.status).end()
  else
    res
      .status(answer.status)
      .type(answer.xml ? 'text/xml' : 'text/plain')
      .send(answer.body)
  answer.after?.()
}

/**
 * WeChat's push callback (see docs/design-notes.md#wxoa): public machine traffic, answered as WeChat
 * expects (plain text or XML, bare status codes), never the envelope; no action or access log, no
 * idempotency or rate-limit decorator (failures are counted by the service instead).
 */
@ApiTags('wxoa')
@Controller('wxoa/callback')
export class WxoaCallbackController {
  constructor(private readonly callbacks: WxoaCallbackService) {}

  @Get(':key')
  @Public()
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiPush(true, ['echostr', 'Echoed once the signature holds (at most 128 characters)', true])
  @ApiProduces('text/plain')
  @ApiOperation({
    summary: 'WeChat URL check: echoes echostr once signature holds (public)',
    description: 'Checks `signature` whatever the encryption mode.',
    security: [],
  })
  @ApiResponse({ status: 200, description: 'The echostr', schema: { type: 'string' } })
  async verify(
    @Param('key') key: string,
    @Query() query: WxoaPushQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.callbacks.verify(key, req.ip ?? '', query))
  }

  @Post(':key')
  @Public()
  @SkipActionLog()
  @SkipHttpTrace()
  @ApiPush(
    false,
    ['msg_signature', 'Compat and secure modes: sha1 of token, timestamp, nonce, Encrypt'],
    ['encrypt_type', 'Compat and secure modes: aes'],
    ['openid', "The fan's openid (not used)"],
  )
  @ApiProduces('text/xml', 'text/plain')
  @ApiConsumes('text/xml')
  @ApiBody({
    description:
      'The push as WeChat sends it, at most 64 KiB: plain XML, or in compat and secure modes an `<xml>` ' +
      'with `Encrypt` (always required there)',
    schema: { type: 'string', example: '<xml><ToUserName><![CDATA[gh_…]]></ToUserName>…</xml>' },
  })
  @ApiOperation({
    summary: 'WeChat push (XML): stored, then answered by a rule or success (public)',
    security: [],
  })
  @ApiResponse({
    status: 200,
    description:
      'A passive reply as text/xml (encrypted in compat and secure modes), else `success` as text/plain',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 400,
    description:
      'Not well-formed XML, a DOCTYPE or ENTITY, a root other than `<xml>`, a field of the wrong ' +
      'shape, or a JSON or form body (no body)',
  })
  @ApiResponse({ status: 403, description: 'Demo mode (envelope `A0431`)' })
  @ApiResponse({ status: 413, description: 'Body over 64 KiB (no body)' })
  async receive(
    @Param('key') key: string,
    @Query() query: WxoaPushQuery,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      await this.callbacks.receive(key, req.ip ?? '', query, () =>
        readBody(req, WXOA_PUSH_MAX_BYTES),
      ),
    )
  }
}
