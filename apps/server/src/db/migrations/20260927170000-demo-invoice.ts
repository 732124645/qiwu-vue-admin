import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Generator demo, master-sub: invoices and their lines, the `master_sub` template's G0
 * sample. An invoice is saved as one document with all its lines (the lines table's rows of one invoice
 * are diffed in the same transaction); `state` holds a `demo.invoice_state` dict value (seeded by
 * db/seeds/demo). Not soft-deleted: an invoice is deleted with its lines (the service deletes them, the
 * FK cascades as well). The column comments are the generator's zh-CN labels.
 */
export class DemoInvoice20260927170000 implements MigrationInterface {
  name = 'DemoInvoice20260927170000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE demo_invoice (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '发票 ID',
      invoice_no varchar(32) NOT NULL COMMENT '发票号码',
      buyer varchar(128) NOT NULL COMMENT '购买方',
      total decimal(12,2) NOT NULL DEFAULT 0.00 COMMENT '价税合计（元）',
      issued_at datetime(3) NULL COMMENT '开票时间（UTC）',
      state varchar(16) NOT NULL DEFAULT 'draft' COMMENT '状态（字典 demo.invoice_state）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_demo_invoice_invoice_no (invoice_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='发票（生成器示例）'`)

    await q.query(`CREATE TABLE demo_invoice_line (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '明细 ID',
      invoice_id bigint unsigned NOT NULL COMMENT '所属发票 ID',
      item varchar(128) NOT NULL COMMENT '品名',
      qty int unsigned NOT NULL DEFAULT 1 COMMENT '数量',
      unit_price decimal(12,2) NOT NULL DEFAULT 0.00 COMMENT '单价（元）',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_demo_invoice_line_invoice (invoice_id),
      CONSTRAINT fk_demo_invoice_line_invoice FOREIGN KEY (invoice_id)
        REFERENCES demo_invoice (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='发票明细（生成器示例）'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE demo_invoice_line, demo_invoice')
  }
}
