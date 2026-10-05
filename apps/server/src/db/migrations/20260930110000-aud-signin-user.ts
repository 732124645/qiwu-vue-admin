import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * GET /me's previous sign-in (`AuditWriter.lastSignIn`: one user's latest row before
 * the session, newest first) is one lookup in `(user_id, created_at)`, not a walk back along created_at.
 * A plain key: no unique key, so no `alive` (deleted rows are filtered by the query).
 */
export class AudSigninUser20260930110000 implements MigrationInterface {
  name = 'AudSigninUser20260930110000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE aud_signin_log ADD KEY idx_aud_signin_log_user_created (user_id, created_at)',
    )
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE aud_signin_log DROP INDEX idx_aud_signin_log_user_created')
  }
}
