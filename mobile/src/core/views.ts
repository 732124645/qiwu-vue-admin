// The mobile view registry: a custom-form process model's web pages (its `create_route`, e.g.
// `/biz/leave/new`, and `view_component`, e.g. `biz/leave/view`) → the mobile pages in pages-biz creating and
// showing its business document. A model missing here is started and viewed on the desktop. A project adds
// its own business pages' lines. Page paths only, in the main package: the approval tab (main) loads this,
// and mp-weixin cannot require a subpackage's code from the main package.
import { leavePerms } from '@qiwu/shared'
import type { IconName } from './components/QwIcon.vue'

/** A field of a form summary: its value shown as is, as a dict label, or as a local time. */
export interface SummaryField {
  prop: string
  dict?: string
  time?: true
}

export interface MobileForm {
  createRoute: string
  viewComponent: string
  /** shows a document: `?id=<business key>&readonly=1` */
  view: string
  /** creates one (the submit starts its process); `?id=<business key>&task=<begin task id>` edits one sent
   * back to its owner and resubmits it */
  form: string
  /** the edit needs it (the PUT's); without it, a resubmit sends the document as it is (as the web) */
  modify: string
  /** its icon (the detail's head, the start page's row; default `doc`) */
  icon?: IconName
  /**
   * The document's key fields on the approval detail. `url` gets the document (`:id` = the business
   * key), `title` is the card's title key, a field's label `<labels>.<prop>`. None: the detail keeps its one
   * "form · view" row.
   */
  summary?: { url: string; title: string; labels: string; fields: readonly SummaryField[] }
}

export const MOBILE_FORMS: readonly MobileForm[] = [
  {
    createRoute: '/biz/leave/new',
    viewComponent: 'biz/leave/view',
    view: '/pages-biz/leave/view',
    form: '/pages-biz/leave/index',
    modify: leavePerms.modify,
    icon: 'calendar',
    summary: {
      url: '/biz/leaves/:id',
      title: 'leave.form',
      labels: 'field.biz.leave',
      fields: [
        { prop: 'leaveKind', dict: 'biz.leave_kind' },
        { prop: 'startAt', time: true },
        { prop: 'endAt', time: true },
        { prop: 'days' },
        { prop: 'reason' },
      ],
    },
  },
]
