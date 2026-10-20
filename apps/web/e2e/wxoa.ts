// Shared by the wxoa specs: a plain-mode account added through the API, WeChat pushes signed here (sha1
// over the sorted Token, timestamp and nonce, as WeChat describes it) and POSTed to the real callback on
// this machine, and the account switch of the wxoa pages.
import { createHash, randomBytes } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { bearer, clientIp, expect, msg, type Page } from './fixtures.ts'

export interface WxoaAccount {
  id: number
  label: string
  /** the push Token the account signs with */
  token: string
  /** `/api/wxoa/callback/<key>` */
  callbackPath: string
}

/**
 * Adds a sandbox account (plain mode) as root. AppID and AppSecret are made up: nothing on the callback
 * path calls WeChat, and the specs never wait for what runs after the answer.
 */
export async function wxoaAccount(request: APIRequestContext, label: string): Promise<WxoaAccount> {
  const token = randomBytes(12).toString('hex')
  const res = await request.post('/api/wxoa/accounts', {
    headers: { Authorization: await bearer(request) },
    data: {
      label,
      accountKind: 'sandbox',
      appId: `wx${randomBytes(8).toString('hex')}`,
      appSecret: randomBytes(16).toString('hex'),
      token,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id, callbackPath } = ((await res.json()) as { data: WxoaAccount }).data
  return { id, label, token, callbackPath }
}

/** A made-up openid. */
export const wxoaOpenId = () => `o${randomBytes(14).toString('hex').slice(0, 27)}`

let seq = 0
const cdata = (s: string) => `<![CDATA[${s}]]>`

/** A push body from fan `openId` to the account `gh_e2e`. */
function pushXml(openId: string, msgType: string, fields: Record<string, string>) {
  const rest = Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('')
  return `<xml><ToUserName>${cdata('gh_e2e')}</ToUserName><FromUserName>${cdata(openId)}</FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType>${cdata(msgType)}</MsgType>${rest}</xml>`
}
export const textPush = (openId: string, content: string) =>
  pushXml(openId, 'text', { Content: cdata(content), MsgId: `${Date.now()}${++seq}` })
export const subscribePush = (openId: string) =>
  pushXml(openId, 'event', { Event: cdata('subscribe'), EventKey: cdata('') })

const sha1 = (...parts: string[]) =>
  createHash('sha1').update(parts.toSorted().join('')).digest('hex')

/** POSTs `body` to the account's callback as WeChat does in plain mode (signed query, raw XML). */
export function push(request: APIRequestContext, account: WxoaAccount, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = `${Date.now()}${++seq}`
  const query = new URLSearchParams({
    signature: sha1(account.token, timestamp, nonce),
    timestamp,
    nonce,
    openid: 'e2e',
  })
  return request.post(`${account.callbackPath}?${query}`, {
    data: body,
    headers: { 'Content-Type': 'text/xml', 'X-Forwarded-For': clientIp() },
  })
}

/** Picks `label` in the account switch at the top of a wxoa page. */
export async function pickAccount(page: Page, label: string) {
  await page
    .getByRole('combobox', { name: msg('field.wxoa.account.accountId') })
    .click({ force: true })
  await page.getByRole('option', { name: label }).click()
  await expect(page.getByRole('option', { name: label })).toBeHidden()
}

/** The envelope of a stubbed management answer (the WeChat call behind it is the server's own test). */
export const ok = (data: unknown = null) => ({ json: { code: 0, msg: 'ok', data } })
