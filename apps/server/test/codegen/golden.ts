// Generator configs of the golden (G0) modules by table: the committed seeds db/seeds/codegen/*.cg.ts,
// stored the way `pnpm db:seed` stores them. Used by the render specs.
import type { DataSource } from 'typeorm'
import { type CgSeed, CG_SEEDS, seedCgConfig } from '../../src/db/seeds/codegen/codegen.seed.js'
import type {
  CgTableDetail,
  CodegenService,
} from '../../src/modules/platform/codegen/codegen.service.js'

export const GOLDEN: Record<string, CgSeed> = Object.fromEntries(
  CG_SEEDS.map((s) => [s.tableName, s]),
)

/** Stores the golden config of `table` like the seed does (run inside a CLS context); returns it. */
export async function importGolden(
  ds: DataSource,
  svc: CodegenService,
  table: string,
): Promise<CgTableDetail> {
  return svc.detail(await seedCgConfig(ds.manager, GOLDEN[table]!))
}
