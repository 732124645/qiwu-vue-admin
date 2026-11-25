// The customer sample's data: a few well-known public companies as sample customers, some fields left
// empty for the MCP tools to fill in. Rows are written once (keyed by name): what an administrator changes
// later is kept on a re-seed.
import type { EntityManager } from 'typeorm'
import { upsert } from '../upsert.js'

const CUSTOMERS: Record<string, string | null>[] = [
  { name: '华为技术有限公司', city: '深圳', industry: null, website: null, phone: null },
  { name: '比亚迪股份有限公司', city: null, industry: '汽车制造', website: null, address: null },
  { name: '美团', website: 'https://www.meituan.com', industry: null, city: null, scale: null },
  { name: '小米科技有限责任公司', city: '北京', industry: '消费电子', website: null, intro: null },
  { name: 'Siemens AG', website: null, industry: null, city: 'Munich', phone: null },
  { name: 'Unilever PLC', website: 'https://www.unilever.com', industry: null, address: null },
  { name: 'Shopify Inc.', website: null, industry: 'E-commerce software', city: null },
]

export async function seedCustomerSamples(q: EntityManager): Promise<string[]> {
  for (const { name, ...fields } of CUSTOMERS)
    await upsert(q, 'demo_customer', { name }, {}, fields)
  return []
}
