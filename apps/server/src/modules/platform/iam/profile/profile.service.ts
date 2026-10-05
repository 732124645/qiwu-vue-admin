import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  type AvatarVo,
  changePasswordBody,
  Err,
  fieldDomainOf,
  type Locale,
  LOCALES,
  PREF_VALUE_MAX_BYTES,
  type ProfileUpdate,
  type ProfileVo,
  profileUpdate,
  STORAGE_IMAGE_MIMES,
  type TableColumnsPref,
  type UserGender,
} from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { type DataSource, IsNull } from 'typeorm'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { AuthService, type Client } from '../../../../core/auth/auth.service.js'
import { BCRYPT_COST } from '../../../../core/auth/password-hash.js'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import type { Principal } from '../../../../core/auth/principal.js'
import { PASSWORD_CHANGED, SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { TokenService } from '../../../../core/auth/token.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../../core/http/upload.js'
import { ValidationException } from '../../../../core/http/validation.pipe.js'
import { StorageService } from '../../storage/storage.service.js'
import { OtpService } from '../../messaging/sms-otp/sms-otp.service.js'
import { User } from '../user/user.entity.js'

/** Avatars are stored as this square WebP (see docs/design-notes.md#storage). */
const AVATAR_SIZE = 256
/** Decoding bound for the uploaded image (a small file can claim huge dimensions): 5000 × 5000. */
const AVATAR_MAX_PIXELS = 25_000_000

const isImage = (mime: string) => (STORAGE_IMAGE_MIMES as readonly string[]).includes(mime)
const asLocale = (v: string | null): Locale | null =>
  LOCALES.includes(v as Locale) ? (v as Locale) : null

interface ProfileRow {
  id: number
  username: string
  display_name: string
  gender: string
  mobile: string | null
  email: string | null
  avatar_url: string | null
  locale: string | null
  dept_name: string | null
}

/**
 * The signed-in user's own profile with the password change (see docs/design-notes.md#auth-sessions) and
 * UI preferences (`iam_user_pref`; key and value are validated by the controller's schemas).
 */
@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: AuthParams,
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly revoker: SessionRevoker,
    private readonly permVersion: PermVersion,
    private readonly storage: StorageService,
    private readonly otp: OtpService,
  ) {}

  /** Own row, unmasked, with the dept, enabled role and position names (i18n key or text). */
  async get(userId: number): Promise<ProfileVo> {
    const [u] = await this.ds.query<ProfileRow[]>(
      `SELECT u.id, u.username, u.display_name, u.gender, u.mobile, u.email, u.avatar_url, u.locale,
              d.name AS dept_name
         FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [userId],
    )
    if (!u) throw new NotFoundException()
    const [roles, positions] = await Promise.all([
      this.ds.query<{ name: string }[]>(
        `SELECT r.name FROM iam_user_roles ur
           JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
          WHERE ur.user_id = ? AND ur.deleted_at IS NULL ORDER BY r.sort_no, r.id`,
        [userId],
      ),
      this.ds.query<{ name: string }[]>(
        `SELECT p.name FROM iam_user_positions up
           JOIN iam_position p ON p.id = up.position_id AND p.deleted_at IS NULL
          WHERE up.user_id = ? AND up.deleted_at IS NULL ORDER BY p.sort_no, p.id`,
        [userId],
      ),
    ])
    return {
      id: Number(u.id),
      username: u.username,
      displayName: u.display_name,
      gender: u.gender as UserGender,
      mobile: u.mobile,
      email: u.email,
      avatarUrl: u.avatar_url,
      locale: asLocale(u.locale),
      deptName: u.dept_name,
      roleNames: roles.map((r) => r.name),
      positionNames: positions.map((p) => p.name),
    }
  }

  /** A changed mobile is verified before the unique index can reveal whether anyone holds it. */
  async update(p: Principal, dto: ProfileUpdate, client: Client): Promise<ProfileVo> {
    const { currentPassword, mobileCode, ...fields } = dto
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    const [stored] = await this.ds.query<{ mobile: string | null; password_hash: string }[]>(
      'SELECT mobile, password_hash FROM iam_user WHERE id = ? AND deleted_at IS NULL',
      [p.userId],
    )
    if (!stored) throw new NotFoundException()
    const mobileChanged = fields.mobile !== undefined && fields.mobile !== stored.mobile
    if (mobileChanged) {
      if (fields.mobile && !(await this.otp.smsConfigured()))
        throw new BizError(Err.IAM_MOBILE_CHANGE_UNAVAILABLE)
      const schema = profileUpdate
        .required({ currentPassword: true })
        .pick({ currentPassword: true })
      const parsed = schema.safeParse({ currentPassword })
      if (!parsed.success) {
        const e = new ValidationException(parsed.error.issues)
        e.domain = fieldDomainOf(profileUpdate)
        throw e
      }
      await this.auth.checkCurrentPassword(
        p,
        parsed.data.currentPassword,
        stored.password_hash,
        client,
        Err.AUTH_OLD_PASSWORD_WRONG,
      )
      if (fields.mobile) {
        if (
          !mobileCode ||
          !(await this.otp.consume(
            { mobile: fields.mobile, scene: 'bind_mobile', code: mobileCode, userId: p.userId },
            client.ip,
          ))
        )
          throw new BizError(Err.AUTH_SMS_CODE_INVALID)
      }
      const changed = await this.ds
        .getRepository(User)
        .createQueryBuilder()
        .update()
        .set(set)
        .where(
          'id = :id AND password_hash = :hash AND mobile <=> :oldMobile AND deleted_at IS NULL',
          {
            id: p.userId,
            hash: stored.password_hash,
            oldMobile: stored.mobile,
          },
        )
        .execute()
      if (changed.affected !== 1) throw new BizError(Err.AUTH_OLD_PASSWORD_WRONG)
      await this.revoker.revokeUser(p.userId, 'mobile_changed', { exceptSid: p.sid })
      if (stored.mobile) await this.otp.voidMobile(stored.mobile)
    } else if (Object.keys(set).length)
      await this.ds.getRepository(User).update({ id: p.userId, deletedAt: IsNull() }, set)
    return this.get(p.userId)
  }

  /**
   * The language the server uses for this user when a request does not name one (messages, notifications). Sessions carry it, so they reload on their next request.
   */
  async setLocale(userId: number, locale: Locale): Promise<void> {
    await this.ds.query(
      'UPDATE iam_user SET locale = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL',
      [locale, userId, userId],
    )
    await this.permVersion.bumpUser(userId)
  }

  /**
   * Any png/jpeg/gif/webp (sniffed; nothing else reaches the decoder) → auto-oriented, center-cropped
   * 256×256 WebP without metadata → a public `avatar` object → `avatar_url`. The previous avatar
   * object is deleted once the new URL is committed.
   */
  async setAvatar(userId: number, file: UploadedFileData | undefined): Promise<AvatarVo> {
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const type = await fileTypeFromBuffer(file.buffer)
    if (!type || !isImage(type.mime)) throw new BizError(Err.STORAGE_PUBLIC_IMAGE_ONLY)
    const webp = await sharp(file.buffer, { limitInputPixels: AVATAR_MAX_PIXELS })
      .autoOrient()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .webp()
      .toBuffer()
      .catch(() => {
        throw new BizError(Err.STORAGE_PUBLIC_IMAGE_ONLY)
      })
    const obj = await this.storage.upload(
      { originalname: 'avatar.webp', mimetype: 'image/webp', size: webp.length, buffer: webp },
      'avatar',
      userId,
    )
    const avatarUrl = obj.url!
    // row lock: of two concurrent uploads each deletes the avatar it replaced, never the same one
    const previous = await this.ds
      .transaction(async (q) => {
        const [row] = await q.query<{ avatar_url: string | null }[]>(
          'SELECT avatar_url FROM iam_user WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
          [userId],
        )
        if (!row) throw new NotFoundException()
        await q.query(
          'UPDATE iam_user SET avatar_url = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL',
          [avatarUrl, userId, userId],
        )
        return row.avatar_url
      })
      .catch(async (e: unknown) => {
        // not referenced by anyone: a retry must not leave public orphans behind
        await this.removeObject(userId, obj.id)
        throw e
      })
    if (previous) await this.removeAvatar(userId, previous)
    return { avatarUrl }
  }

  /** The avatar object behind a URL this user uploaded (anything else is left alone). */
  private async removeAvatar(userId: number, url: string): Promise<void> {
    const [obj] = await this.ds
      .query<{ id: number }[]>(
        "SELECT id FROM fs_object WHERE public_url = ? AND biz_tag = 'avatar' AND uploader_id = ? AND deleted_at IS NULL",
        [url, userId],
      )
      .catch(() => [])
    if (obj) await this.removeObject(userId, Number(obj.id))
  }

  /** Best effort: the request's outcome is already decided, a leftover file is only an orphan. */
  private async removeObject(userId: number, id: number): Promise<void> {
    await this.storage
      .remove(id)
      .catch((e: unknown) =>
        this.logger.warn(`avatar object ${id} of user ${userId} not removed: ${String(e)}`),
      )
  }

  /**
   * Validates against the current `cfg_param` policy (the shared schema: length, character classes,
   * ≤ 72 UTF-8 bytes, new ≠ old) → old password by bcrypt → new hash + `password_changed_at` → every
   * other session of the user revoked → the caller's session loses its password flags.
   */
  async changePassword(p: Principal, body: unknown, client: Client): Promise<void> {
    const { policy } = await this.params.load()
    const schema = changePasswordBody(policy)
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      const e = new ValidationException(parsed.error.issues)
      e.domain = fieldDomainOf(schema)
      throw e
    }
    const { oldPassword, newPassword } = parsed.data
    const [row] = await this.ds.query<{ password_hash: string }[]>(
      'SELECT password_hash FROM iam_user WHERE id = ? AND deleted_at IS NULL',
      [p.userId],
    )
    await this.auth.checkCurrentPassword(
      p,
      oldPassword,
      row?.password_hash ?? null,
      client,
      Err.AUTH_OLD_PASSWORD_WRONG,
    )

    // compare-and-set on the verified hash: of two concurrent changes only one wins (and revokes)
    const res = await this.ds.query<{ affectedRows: number }>(
      `UPDATE iam_user SET password_hash = ?, password_changed_at = ?, updated_by = ?
        WHERE id = ? AND password_hash = ? AND deleted_at IS NULL`,
      [
        await bcrypt.hash(newPassword, BCRYPT_COST),
        new Date(),
        p.userId,
        p.userId,
        row.password_hash,
      ],
    )
    if (res.affectedRows !== 1) throw new BizError(Err.AUTH_OLD_PASSWORD_WRONG)
    await this.revoker.revokeUser(p.userId, PASSWORD_CHANGED, { exceptSid: p.sid })
    const session = p.sid ? await this.tokens.load(p.sid) : null
    if (session)
      await this.tokens.save({
        ...session,
        flags: { mustChangePassword: false, passwordExpired: false },
      })
  }

  /** The user's value of `key`, `null` while unset. */
  async getPref(userId: number, key: string): Promise<TableColumnsPref | null> {
    const [row] = await this.ds.query<{ value: TableColumnsPref }[]>(
      'SELECT value FROM iam_user_pref WHERE user_id = ? AND pref_key = ? AND deleted_at IS NULL',
      [userId, key],
    )
    return row?.value ?? null
  }

  /** Insert or replace (a reset key comes back); a value over `PREF_VALUE_MAX_BYTES` → 413. */
  async setPref(userId: number, key: string, value: TableColumnsPref): Promise<void> {
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > PREF_VALUE_MAX_BYTES) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    await this.ds.query(
      `INSERT INTO iam_user_pref (user_id, pref_key, value) VALUES (?, ?, ?) AS n
         ON DUPLICATE KEY UPDATE value = n.value, deleted_at = NULL`,
      [userId, key, json],
    )
  }

  /** Back to the page defaults (the row soft-deleted); unset keys are fine. */
  async deletePref(userId: number, key: string): Promise<void> {
    await this.ds.query(
      `UPDATE iam_user_pref SET deleted_at = CURRENT_TIMESTAMP(3)
        WHERE user_id = ? AND pref_key = ? AND deleted_at IS NULL`,
      [userId, key],
    )
  }
}
