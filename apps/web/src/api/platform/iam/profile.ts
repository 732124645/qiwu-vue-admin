import type {
  AvatarVo,
  Locale,
  ProfileUpdate,
  ProfileVo,
  SmsCodeVo,
  SocialBindingVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/iam/profile'

/** /api/iam/profile: the signed-in user's own data (personal center), no permission needed. */
export const profileApi = {
  get: () => api.get<ProfileVo>(BASE),
  update: (body: ProfileUpdate) => api.put<ProfileVo>(BASE, body),
  mobileCode: (mobile: string) => api.post<SmsCodeVo>(`${BASE}/mobile/code`, { mobile }),
  /** the language the server uses for this user when a request names none (notifications, Excel) */
  setLocale: (locale: Locale) => api.put(`${BASE}/locale`, { locale }, { silent: true }),
  /** own sign-in bindings (WeChat mini program) */
  socials: () => api.get<SocialBindingVo[]>(`${BASE}/socials`),
  unbindWxMp: () => api.delete(`${BASE}/socials/wx-mp`),
  /** a cropped image → 256×256 webp, public; resolves with its URL */
  avatar(file: File) {
    const form = new FormData()
    form.append('file', file)
    return api.post<AvatarVo>(`${BASE}/avatar`, form, { timeout: 2 * 60_000 })
  },
}
