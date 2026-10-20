import { applyDecorators } from '@nestjs/common'
import { ApiResponse, ApiTags } from '@nestjs/swagger'
import { Err, type ErrorDef } from '@qiwu/shared'

/** Every envelope code of the management routes besides the validation and permission ones. */
const ERRORS: [ErrorDef, string][] = [
  [Err.DEMO_READ_ONLY, 'demo mode: writes and calls to WeChat are refused'],
  [
    Err.NOT_FOUND,
    'the account or row is missing or deleted, or an id of the request belongs to another account',
  ],
  [Err.STORAGE_FILE_REQUIRED, 'a material upload without a file'],
  [
    Err.DUPLICATE,
    'an AppID, a QR code scene or a reply rule of a one-rule trigger or event key already exists',
  ],
  [Err.IN_USE, 'a material deleted while a reply rule refers to it'],
  [Err.WXOA_SYNC_RUNNING, 'a sync of the same kind is running for the account'],
  [
    Err.PAYLOAD_TOO_LARGE,
    "a material over WeChat's or the storage size limit, or a WeChat answer over its size cap",
  ],
  [
    Err.UNPROCESSABLE,
    "over 500 reply rules or the account's tag limit, or a change to one of WeChat's reserved tags",
  ],
  [
    Err.STORAGE_TYPE_REJECTED,
    'a file of a type WeChat does not take or not what its extension says, or a WeChat answer that is no medium',
  ],
  [Err.TOO_MANY_REQUESTS, 'the same create request repeated within 3 s'],
  [Err.WXOA_UPSTREAM_REFUSED, 'WeChat refused the call with an errcode of no own code (`errcode`)'],
  [Err.WXOA_API_UNAUTHORIZED, 'the account may not call that WeChat API (unverified, sandbox)'],
  [Err.WXOA_IP_NOT_ALLOWED, "this server's IP is not on the account's IP whitelist (`ip`)"],
  [Err.WXOA_CREDENTIAL_INVALID, 'WeChat does not accept the AppID or AppSecret'],
  [Err.WXOA_SEND_WINDOW, "the fan's customer-service windows are closed or used up"],
  [Err.WXOA_AES_KEY_REQUIRED, 'compat or secure mode without an EncodingAESKey'],
  [Err.WXOA_DEFAULT_MENU_REQUIRED, 'a conditional menu published before the default menu'],
  [Err.WXOA_ACCOUNT_DISABLED, 'the account is disabled'],
  [Err.WXOA_DRAFT_UNSYNCED, 'the draft has local changes that have not been synced to WeChat'],
  [Err.WXOA_COVER_UNAVAILABLE, 'the draft cover is not a usable permanent image of this account'],
  [Err.WXOA_MASS_RETRY_EXPIRED, 'a mass job retried more than 23 hours after it was created'],
  [Err.WXOA_QUOTA_EXCEEDED, "today's quota of that WeChat API is used up"],
  [Err.WXOA_UPSTREAM, 'WeChat unreachable, or its answer not 200 or unreadable'],
]

/**
 * Swagger of a wxoa management controller (see docs/design-notes.md#wxoa): the `wxoa` tag and, per
 * HTTP status, the envelope codes its routes may answer, each with the case it stands for (the WeChat
 * ones from routes that call it).
 */
export function ApiWxoa(): ClassDecorator {
  const byStatus = new Map<number, string[]>()
  for (const [err, what] of ERRORS)
    byStatus.set(err.status, [...(byStatus.get(err.status) ?? []), `\`${err.code}\` ${what}`])
  return applyDecorators(
    ApiTags('wxoa'),
    ...[...byStatus].map(([status, lines]) =>
      ApiResponse({ status, description: lines.join('; ') }),
    ),
  )
}
