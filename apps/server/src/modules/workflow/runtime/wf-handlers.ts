import { Injectable, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import type { WfFields } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import type { WfInstanceRow } from './wf-runtime.entity.js'

/**
 * A `custom` form's side of a process (see docs/design-notes.md#workflow), registered per model key with the class decorator
 * `@WfBusinessHandler('<modelKey>')` on a provider. Every method runs synchronously inside the workflow
 * action's transaction (`tx`, no event emitter: that swallows errors): a throw rolls the whole action back.
 */
export interface WfBusinessHandler {
  /** the form's field list: `compile` checks conditions against it, the version snapshot stores it */
  fields(): WfFields
  /**
   * Before a start: locks the business row (`FOR UPDATE`) and requires it to be the initiator's own, in
   * `draft` and not bound to an instance; not theirs / missing → 404, started already → 409.
   */
  assertStartable(businessKey: string, initiatorId: number, tx: EntityManager): Promise<void>
  /** the form values the engine decides on, read from the business row (client values are ignored) */
  loadFormValues(businessKey: string, tx: EntityManager): Promise<Record<string, unknown>>
  /** after the instance was created (`running`, or already ended) and whenever an action changes its state */
  onStateChange(instance: WfInstanceRow, tx: EntityManager): Promise<void>
}

/** Class decorator: the provider is the `WfBusinessHandler` of model `modelKey`. */
export const WfBusinessHandler = DiscoveryService.createDecorator<string>()

/**
 * The `WfBusinessHandler` registry (`Map<modelKey, handler>`), collected from the app's providers once at
 * start; a model key registered twice fails the start. Needs `DiscoveryModule` in its module.
 */
@Injectable()
export class WfHandlers implements OnModuleInit {
  private readonly byKey = new Map<string, WfBusinessHandler>()

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: WfBusinessHandler.KEY })) {
      const key = this.discovery.getMetadataByDecorator(WfBusinessHandler, wrapper)
      if (key === undefined || !wrapper.instance) continue
      if (this.byKey.has(key)) throw new Error(`@WfBusinessHandler('${key}') registered twice`)
      this.byKey.set(key, wrapper.instance as WfBusinessHandler)
    }
  }

  /** the handler of model `modelKey`; none for a `dynamic` form */
  get(modelKey: string): WfBusinessHandler | undefined {
    return this.byKey.get(modelKey)
  }
}
