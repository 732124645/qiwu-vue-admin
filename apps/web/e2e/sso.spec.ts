// The /sso consent page: sign-in comes back to the request; approving sends the browser
// to the client's callback with a code the token endpoint takes; a remembered consent skips the page; deny
// → access_denied; an invalid request stays on /sso with the server's message, never redirected.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { APIRequestContext } from '@playwright/test'
import { USERS } from './env.ts'
import { bearer, expect, msg, signIn, submitLogin, test, type Page } from './fixtures.ts'

const RUN = Date.now().toString(36)
const A = `e2e-sso-a-${RUN}`
const B = `e2e-sso-b-${RUN}`

const CB = 'http://localhost:4199/cb'
/** the browser at the client's callback, with a query */
const AT_CB = /^http:\/\/localhost:4199\/cb\?/
const EVIL = 'https://evil.example.com/cb'
/** the server's own zh-CN error texts (the page shows them as answered) */
const serverError = (
  JSON.parse(
    readFileSync(new URL('../../server/src/i18n/zh-CN/error.json', import.meta.url), 'utf8'),
  ) as { oauth: Record<string, string> }
).oauth
const secrets: Record<string, string> = {}

async function client(request: APIRequestContext, clientId: string) {
  const res = await request.post('/api/oauth/clients', {
    headers: { Authorization: await bearer(request) },
    data: {
      clientId,
      name: `SSO ${clientId}`,
      grantTypes: ['authorization_code', 'refresh_token'],
      redirectUris: [CB],
      scopes: ['user.read'],
      autoApproveScopes: [],
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  secrets[clientId] = ((await res.json()) as { data: { secret: string } }).data.secret
}

test.beforeAll(async ({ request }) => {
  await client(request, A)
  await client(request, B)
})

/** An authorization request as a third party builds it (PKCE S256), and its verifier. */
function authorize(clientId: string, state: string, extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CB,
    scope: 'user.read',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...extra,
  })
  return { url: `/sso?${query}`, verifier }
}

/** The client's callback, answered here (nothing listens on it). */
async function callback(page: Page) {
  await page.route('http://localhost:4199/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>cb</title>' }),
  )
}
const answered = (page: Page) => new URL(page.url()).searchParams

/** Watches the page never leaving for an unverified host. */
async function noEvil(page: Page) {
  const hits: string[] = []
  await page.route('https://evil.example.com/**', (r) => {
    hits.push(r.request().url())
    return r.abort()
  })
  return hits
}

async function stays(page: Page, text?: string) {
  const alert = page.getByRole('alert')
  await expect(alert).toBeVisible()
  if (text) await expect(alert).toContainText(text)
  expect(new URL(page.url()).pathname).toBe('/sso')
  await expect(page.getByRole('button', { name: msg('oauth.sso.approve') })).toHaveCount(0)
}

test('sign in → consent → code → token → userinfo; a remembered consent skips the page', async ({
  page,
  request,
}) => {
  await callback(page)
  const first = authorize(A, 's1')
  await page.goto(first.url)
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await submitLogin(page, USERS.admin)

  await expect(page.getByRole('heading', { name: msg('oauth.sso.title') })).toBeVisible()
  await expect(page.getByText(`SSO ${A}`, { exact: true })).toBeVisible()
  await expect(page.getByText(msg('oauth.scope.user_read'))).toBeVisible()
  await expect(
    page.getByText(msg('oauth.sso.redirectHost', 'zh-CN', { host: 'localhost:4199' })),
  ).toBeVisible()
  await page.getByRole('button', { name: msg('oauth.sso.approve') }).click()
  await page.waitForURL(AT_CB)
  expect(answered(page).get('state')).toBe('s1')
  const code = answered(page).get('code')
  expect(code).toBeTruthy()

  // the third party's back end: code + verifier → tokens → the user
  const token = await request.post('/api/oauth2/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: CB,
      code_verifier: first.verifier,
    },
    headers: {
      Authorization: `Basic ${Buffer.from(`${A}:${secrets[A]}`).toString('base64')}`,
    },
  })
  expect(token.status(), await token.text()).toBe(200)
  const { access_token } = (await token.json()) as { access_token: string }
  const me = await request.get('/api/oauth2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  })
  expect(me.status()).toBe(200)
  expect(((await me.json()) as { data: { username: string } }).data.username).toBe('admin')

  // same user, same client, a new request: consent remembered → straight to the callback
  await page.goto(authorize(A, 's2').url)
  await page.waitForURL(AT_CB)
  expect(answered(page).get('state')).toBe('s2')
  expect(answered(page).get('code')).toBeTruthy()
})

test('deny → the callback with error=access_denied and the state, no code', async ({ page }) => {
  await callback(page)
  await signIn(page, 'admin', authorize(B, 'st-deny').url)
  await page.getByRole('button', { name: msg('oauth.sso.deny') }).click()
  await page.waitForURL(AT_CB)
  expect(answered(page).get('error')).toBe('access_denied')
  expect(answered(page).get('state')).toBe('st-deny')
  expect(answered(page).has('code')).toBe(false)
})

test('invalid requests stay on /sso with the error, never redirected', async ({ page }) => {
  const evil = await noEvil(page)
  // a redirect_uri the client never registered
  await signIn(page, 'admin', authorize(B, 'x', { redirect_uri: EVIL }).url)
  await stays(page, serverError.client_invalid)
  // an unknown client
  await page.goto(authorize('nope', 'x', { redirect_uri: EVIL }).url)
  await stays(page, serverError.client_invalid)
  // PKCE plain (no method): rejected before any client lookup
  const plain = authorize(B, 'x')
  await page.goto(plain.url.replace('&code_challenge_method=S256', ''))
  await stays(page)
  expect(evil).toEqual([])
})
