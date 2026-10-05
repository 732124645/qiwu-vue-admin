/** Shared by startup validation and the DB CLIs, before they open a connection. */
export function assertProductionSecrets(
  env: Partial<Record<'NODE_ENV' | 'APP_SECRET' | 'SEED_ADMIN_PASSWORD', string>>,
  onInvalid: (field: 'APP_SECRET' | 'SEED_ADMIN_PASSWORD', message: string) => void = (
    field,
    message,
  ) => {
    throw new Error(`${field}: ${message}`)
  },
): void {
  if (env.NODE_ENV !== 'production') return
  for (const field of ['APP_SECRET', 'SEED_ADMIN_PASSWORD'] as const)
    if (/not-for-production/i.test(env[field] ?? ''))
      onInvalid(field, 'production credentials must not contain the test marker')
}
