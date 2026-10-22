import { oaExpensePerms, oaSealPerms, oaTripPerms, type Page } from '@qiwu/shared'
import { tripApi } from '@/api/oa/trip'
import { expenseApi } from '@/api/oa/expense'
import { sealApi } from '@/api/oa/seal'
import type { QwColumn } from '@/core/composables/use-table-prefs'

export interface OfficeDocument {
  id: number
  userId: number
  state: string
  instanceId: number | null
  attachmentIds: number[]
  createdAt: string
  startAt?: string
}
export interface OfficeResource {
  kind: 'trip' | 'expense' | 'seal'
  modelKey: string
  path: string
  perms: { browse: string; view: string; create: string; modify: string }
  api: {
    page: (query: Record<string, unknown>) => Promise<Page<OfficeDocument>>
    get: (id: number) => Promise<OfficeDocument>
  }
  columns: QwColumn[]
  fields: { prop: string; label: string; kind?: 'time' | 'dict'; dict?: string }[]
}
const common: QwColumn[] = [
  { prop: 'state', label: 'field.oa.trip.state', width: 120 },
  { prop: 'createdAt', label: 'field.common.createdAt', width: 180, sortable: true },
]
export const officeResources: Record<OfficeResource['kind'], OfficeResource> = {
  trip: {
    kind: 'trip',
    modelKey: 'oa-trip',
    path: '/oa/trip',
    perms: oaTripPerms,
    api: tripApi,
    columns: [
      { prop: 'destination', label: 'field.oa.trip.destination', minWidth: 160 },
      { prop: 'startAt', label: 'field.oa.trip.startAt', width: 180 },
      ...common,
    ],
    fields: [
      { prop: 'destination', label: 'field.oa.trip.destination' },
      { prop: 'startAt', label: 'field.oa.trip.startAt', kind: 'time' },
      { prop: 'endAt', label: 'field.oa.trip.endAt', kind: 'time' },
      { prop: 'estimatedAmount', label: 'field.oa.trip.estimatedAmount' },
      { prop: 'reason', label: 'field.oa.trip.reason' },
    ],
  },
  expense: {
    kind: 'expense',
    modelKey: 'oa-expense',
    path: '/oa/expense',
    perms: oaExpensePerms,
    api: expenseApi,
    columns: [
      { prop: 'reason', label: 'field.oa.expense.reason', minWidth: 180 },
      { prop: 'totalAmount', label: 'field.oa.expense.totalAmount', width: 150 },
      ...common,
    ],
    fields: [
      { prop: 'reason', label: 'field.oa.expense.reason' },
      { prop: 'tripId', label: 'field.oa.expense.tripId' },
      { prop: 'totalAmount', label: 'field.oa.expense.totalAmount' },
      { prop: 'currency', label: 'field.oa.expense.currency' },
    ],
  },
  seal: {
    kind: 'seal',
    modelKey: 'oa-seal',
    path: '/oa/seal',
    perms: oaSealPerms,
    api: sealApi,
    columns: [
      { prop: 'documentName', label: 'field.oa.seal.documentName', minWidth: 180 },
      { prop: 'copies', label: 'field.oa.seal.copies', width: 100 },
      ...common,
    ],
    fields: [
      { prop: 'sealKind', label: 'field.oa.seal.sealKind', kind: 'dict', dict: 'oa.seal_kind' },
      { prop: 'documentName', label: 'field.oa.seal.documentName' },
      { prop: 'purpose', label: 'field.oa.seal.purpose' },
      { prop: 'copies', label: 'field.oa.seal.copies' },
      { prop: 'expectedDate', label: 'field.oa.seal.expectedDate' },
    ],
  },
}
