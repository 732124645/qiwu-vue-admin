import { Injectable } from '@nestjs/common'
import type { Principal } from '../../../core/auth/principal.js'
import type { FsObject } from './fs-object.entity.js'

/** Decides whether `principal` may download a private object of its business tag (usually by `bizRef`). */
export type StorageAccessChecker = (obj: FsObject, principal: Principal) => Promise<boolean>

/**
 * Per-business-tag access checkers for private downloads (see docs/design-notes.md#storage): a module owning a tag registers
 * one at init, e.g. workflow's instance access rule for attachments with `biz_ref = 'wf:<id>'` (see docs/design-notes.md#workflow).
 * The uploader and holders of `storage.object.view` need none.
 */
@Injectable()
export class StorageAccess {
  private readonly checkers = new Map<string, StorageAccessChecker>()

  register(bizTag: string, checker: StorageAccessChecker): void {
    if (this.checkers.has(bizTag))
      throw new Error(`StorageAccess: '${bizTag}' already has a checker`)
    this.checkers.set(bizTag, checker)
  }

  /** No checker for the tag → false. */
  async allows(obj: FsObject, principal: Principal): Promise<boolean> {
    const checker = this.checkers.get(obj.bizTag)
    return checker ? checker(obj, principal) : false
  }
}
