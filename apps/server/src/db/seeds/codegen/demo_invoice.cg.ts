// Generator config of the demo_invoice sample module (G0; see docs/design-notes.md#codegen): the `master_sub` template's
// sample, the edits on top of the import defaults of the master (demo_invoice) and its sub table
// (demo_invoice_line, linked by `invoice_id`): one page whose form edits an invoice with all its lines,
// saved as one document. Export stays on (the invoice list); the page hangs under the `demo` menu group
// (系统工具 / 生成示例, the import default: the domain) after the topics. Change it only together with the
// committed module files (`pnpm gen:check-golden` re-renders them from it).
import type { CgSeed } from './codegen.seed.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

export const demoInvoiceCg: CgSeed = {
  tableName: 'demo_invoice',
  table: {
    template: 'master_sub',
    featureNameI18n: both('发票', 'Invoices'),
    options: {
      // the uni-app pages too (rendered only where the repository has the mobile client)
      withMobile: true,
      menuIcon: 'lucide:receipt-text',
      menuSortNo: 30,
      entityI18n: both('发票', 'invoice'),
    },
  },
  columns: {
    invoice_no: { labelI18n: both('发票号码', 'Invoice no.'), inQuery: true, queryOp: 'like' },
    buyer: { labelI18n: both('购买方', 'Buyer'), inQuery: true, queryOp: 'like' },
    total: { labelI18n: both('价税合计', 'Total'), example: '1280.5' },
    issued_at: { labelI18n: both('开票时间', 'Issued at') },
    state: {
      labelI18n: both('状态', 'State'),
      widget: 'select',
      dictCode: 'demo.invoice_state',
      inQuery: true,
      queryOp: 'eq',
      example: 'issued',
    },
  },
}

export const demoInvoiceLineCg: CgSeed = {
  tableName: 'demo_invoice_line',
  master: 'demo_invoice',
  table: {
    subFkCol: 'invoice_id',
    featureNameI18n: both('发票明细', 'Lines'),
    options: { entityI18n: both('明细', 'line') },
  },
  columns: {
    invoice_id: { labelI18n: both('所属发票', 'Invoice') },
    item: { labelI18n: both('品名', 'Item') },
    qty: { labelI18n: both('数量', 'Quantity') },
    unit_price: { labelI18n: both('单价', 'Unit price'), example: '99.9' },
  },
}
