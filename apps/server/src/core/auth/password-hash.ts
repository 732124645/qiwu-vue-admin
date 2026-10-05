/** bcrypt cost of every stored password hash: seeds, user admin, sign-up, profile, SMS reset (see docs/design-notes.md#auth-sessions). */
export const BCRYPT_COST = 12

/**
 * bcrypt (at {@link BCRYPT_COST}, like real hashes) of a random secret nobody knows: unknown, disabled
 * and deleted users still cost one full compare, so timing does not tell them apart (see docs/design-notes.md#auth-sessions).
 */
export const FAKE_HASH = '$2b$12$w7yxgnPwcyKAjk2n69F/4umCCj/uM/O0KscgsGghv2hMDSL5olGGi'
