import { Module } from '@nestjs/common'
import { referencedBy } from '../core/db/references.js'
import { LeaveModule } from './biz/leave/leave.module.js'
import { BookModule } from './demo/book/book.module.js'
import { InvoiceModule } from './demo/invoice/invoice.module.js'
import { DemoRealtimeModule } from './demo/realtime/realtime.module.js'
import { TopicModule } from './demo/topic/topic.module.js'

// The former foreign key of the book sample: a dept holding books is in use (an invoice's lines go
// with it: invoice.entity.ts, generated from the master-sub link)
referencedBy('iam_dept', { table: 'demo_book', column: 'dept_id' })

/**
 * Project business (see docs/design-notes.md#layering): the one registration point of the project domains
 * (`modules/<domain>/`: `biz`, the samples' `demo`, a project's own); `pnpm gen` prints the lines for
 * each generated module. The generator's single-table sample (demo_book), its tree sample (demo_topic)
 * and its master-sub sample (demo_invoice with its lines); the hand-written realtime push demo; the OA
 * leave requests (process `leave`).
 */
@Module({
  imports: [BookModule, TopicModule, InvoiceModule, DemoRealtimeModule, LeaveModule],
})
export class ProjectModule {}
