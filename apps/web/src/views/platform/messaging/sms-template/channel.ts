/**
 * `auth.*` templates carry the sign-in / reset codes: they send only through their own chosen, enabled channel and
 * never fall back to the default one (an admin who may edit ordinary channels could read the codes), so
 * without a channel no code is sent. The same test as the server's `isAuthTemplate`.
 */
export const isAuthTemplate = (code: string): boolean => code.toLowerCase().startsWith('auth.')
