import { seedOaSeal } from './oa-seal.seed.js'
import { seedOaGeneric } from './oa-generic.seed.js'
import { seedOaExpense } from './oa-expense.seed.js'
// Project tenant seeds: the base data every tenant other than the default one needs (its own dict-like
// rows, a starting category tree, a process model of a project page, …). They run after the platform's
// tenant seeds (db/seeds/index.ts, TENANT_SEEDS), in that tenant (the seed helpers in upsert.ts keep to
// its rows): when a tenant is opened, in the same transaction, and for every existing tenant on each
// `db:seed`, so a release that adds one fills the tenants opened before it. SEEDS.project only seeds the
// default tenant. Keep each seed insert-only by natural key and never revive a row the tenant deleted
// (findRow finds the deleted ones too), as the platform's tenant seeds do.
// This file belongs to the project (the template ships it empty).
import type { EntityManager } from 'typeorm'
import { seedOaTrip } from './oa-trip.seed.js'

/** A seed of one tenant: runs in tenant `tid`, returns one-time notices for the operator. */
export type TenantSeed = (q: EntityManager, tid: number) => Promise<string[]>

export const PROJECT_TENANT_SEEDS: TenantSeed[] = [
  seedOaTrip,
  seedOaExpense,
  seedOaSeal,
  seedOaGeneric,
]
