import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * One live default per dict, including disabled entries. Keep the default with the
 * smallest sort_no, then id; deleted defaults remain untouched. Pause dict writes during upgrade.
 * MySQL DDL commits implicitly: a failed up is not rolled back as a whole. Down removes the
 * constraint but does not restore the duplicate defaults cleared by up.
 */
export class DictSingleDefault20261002120000 implements MigrationInterface {
  name = 'DictSingleDefault20261002120000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE cfg_dict_entry e
      JOIN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY dict_code ORDER BY sort_no, id) AS rn
          FROM cfg_dict_entry
          WHERE is_default = 1 AND deleted_at IS NULL
        ) ranked WHERE rn > 1
      ) duplicate_default ON duplicate_default.id = e.id
      SET e.is_default = 0`)

    await q.query(`ALTER TABLE cfg_dict_entry
      ADD COLUMN default_one tinyint AS (IF(is_default = 1, 1, NULL)) VIRTUAL
        COMMENT '默认项为 1、其余为空（唯一索引用）' AFTER is_default,
      ADD UNIQUE KEY uk_cfg_dict_entry_default (dict_code, default_one, alive)`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'ALTER TABLE cfg_dict_entry DROP INDEX uk_cfg_dict_entry_default, DROP COLUMN default_one',
    )
  }
}
