import { Module, type OnModuleInit } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { TypeOrmModule } from '@nestjs/typeorm'
import { StorageAccess } from '../platform/storage/storage-access.js'
import { StorageModule } from '../platform/storage/storage.module.js'
import { WfAdminController } from './admin/wf-admin.controller.js'
import { WfAdminService } from './admin/wf-admin.service.js'
import { WfDataController } from './admin/wf-data.controller.js'
import { WfDataService } from './admin/wf-data.service.js'
import { WfCenterController } from './center/wf-center.controller.js'
import { WfDecideService } from './center/wf-decide.service.js'
import { WfDetailService } from './center/wf-detail.service.js'
import { WfListService } from './center/wf-lists.service.js'
import { WfRoutingController } from './center/wf-routing.controller.js'
import { WfRoutingService } from './center/wf-routing.service.js'
import { WfStartService } from './center/wf-start.service.js'
import { WfTaskController } from './center/wf-task.controller.js'
import { WfFormController } from './form/wf-form.controller.js'
import { WfForm } from './form/wf-form.entity.js'
import { WfFormService } from './form/wf-form.service.js'
import { WfModelController } from './model/wf-model.controller.js'
import { WfModel, WfVersion } from './model/wf-model.entity.js'
import { WfModelService } from './model/wf-model.service.js'
import { WfHandlers } from './runtime/wf-handlers.js'
import { WfNotify } from './runtime/wf-notify.js'
import { WfRemind } from './runtime/wf-remind.js'
import { WF_RUNTIME_ENTITIES } from './runtime/wf-runtime.entity.js'
import { WF_ORG, WfStore } from './runtime/wf-store.js'
import { typeormOrg } from './typeorm-org.js'

/**
 * Workflow (see docs/design-notes.md#layering, #workflow): the one registration point of `modules/workflow`. Business modules mark their
 * handler provider `@WfBusinessHandler('<modelKey>')` (runtime/wf-handlers.ts); `WfHandlers` collects them.
 * The engine's org chart reads through the current transaction (`txHost.tx`), so a start or an action sees
 * the rows its own transaction wrote. Form attachments (`wf.attachment`, bound to `wf:<instanceId>` on start,
 * approve and resubmit) download for whoever may see that instance and the field naming them (see docs/design-notes.md#storage, #workflow).
 */
@Module({
  imports: [
    DiscoveryModule,
    StorageModule,
    TypeOrmModule.forFeature([WfModel, WfVersion, WfForm, ...WF_RUNTIME_ENTITIES]),
  ],
  controllers: [
    WfModelController,
    WfFormController,
    WfCenterController,
    WfTaskController,
    WfRoutingController,
    WfAdminController,
    WfDataController,
  ],
  providers: [
    WfHandlers,
    WfNotify,
    WfRemind,
    WfModelService,
    WfFormService,
    WfStore,
    WfStartService,
    WfDetailService,
    WfListService,
    WfDecideService,
    WfRoutingService,
    WfAdminService,
    WfDataService,
    {
      provide: WF_ORG,
      inject: [TransactionHost],
      useFactory: (txHost: TransactionHost<TransactionalAdapterTypeOrm>) =>
        typeormOrg({
          // arch-allow: sql-concat forwards typeorm-org's literal, parameterized SQL to the current tx
          query: (sql: string, params?: unknown[]) => txHost.tx.query(sql, params),
        }),
    },
  ],
  exports: [WfStartService, WfDetailService, WfNotify],
})
export class WorkflowModule implements OnModuleInit {
  constructor(
    private readonly access: StorageAccess,
    private readonly detail: WfDetailService,
  ) {}

  onModuleInit(): void {
    // `canDownload` judges the request's (CLS) principal: the downloader's
    this.access.register('wf.attachment', async (obj) => {
      const id = /^wf:(\d+)$/.exec(obj.bizRef ?? '')?.[1]
      return id !== undefined && this.detail.canDownload(Number(id), Number(obj.id))
    })
  }
}
