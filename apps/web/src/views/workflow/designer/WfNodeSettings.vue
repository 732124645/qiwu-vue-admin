<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  WF_NAME_MAX,
  WF_ON_REJECT,
  WF_RESUBMIT_TO,
  WF_SIGN_MODES,
  WF_TIMEOUT_ACTIONS,
  WF_TIMEOUT_HOURS_MAX,
  WF_WHEN_INITIATOR_IS_REVIEWER,
  WF_WHEN_NOBODY,
  type WfFields,
  type WfTimeoutAction,
} from '@qiwu/shared'
import UserSelect from '@/core/components/UserSelect.vue'
import { i18n, tx } from '@/core/i18n'
import WfAssigneeEditor from './WfAssignee.vue'
import WfCondBuilder from './WfCondBuilder.vue'
import WfFieldAccess from './WfFieldAccess.vue'
import type { Target } from './tree'
import { useUserNames } from './user-names'

/** The settings form of one node or fork path; edits it in place. Hosted by WfNodeDrawer (tree designer). */
defineOptions({ name: 'WfNodeSettings' })
const { target, fields } = defineProps<{ target: Target; fields: WfFields }>()
const { t } = useI18n()

const node = computed(() => ('node' in target ? target.node : undefined))
const path = computed(() => ('path' in target ? target.path : undefined))
const parallel = computed(() => 'fork' in target && target.fork.mode === 'parallel')
/** what the name field edits */
const named = computed(() => node.value ?? path.value!)
/** node / path → its seed key (see docs/design-notes.md#i18n): shown translated, kept while the text is left as shown */
const seedKeys = new WeakMap<object, string>()
const name = computed({
  get: () => tx(named.value.name),
  set: (text: string) => {
    const n = named.value
    const was = n.name.startsWith('seed.') && i18n.global.te(n.name) ? n.name : undefined
    const key = seedKeys.get(n) ?? was
    if (key) seedKeys.set(n, key)
    n.name = key && text === tx(key) ? key : text
  },
})
const review = computed(() => (node.value?.type === 'review' ? node.value : undefined))
const notify = computed(() => (node.value?.type === 'notify' ? node.value : undefined))
const withAccess = computed(() =>
  node.value?.type === 'begin' || node.value?.type === 'review' ? node.value : undefined,
)

const DAY = 24
const fallbackNames = useUserNames(() =>
  review.value?.fallbackUserId ? [review.value.fallbackUserId] : [],
)
const fallbackUser = computed({
  get: () => review.value?.fallbackUserId ?? null,
  set: (id) => {
    if (id == null) delete review.value!.fallbackUserId
    else review.value!.fallbackUserId = id
  },
})
function setWhenNobody(v: (typeof WF_WHEN_NOBODY)[number]) {
  review.value!.whenNobody = v
  if (v !== 'toUser') delete review.value!.fallbackUserId
}
const timeoutOn = computed({
  get: () => !!review.value?.timeout,
  set: (on) => {
    if (on) review.value!.timeout = { hours: DAY }
    else delete review.value!.timeout
  },
})
/** after the due time: `remind` (the default) is never written, it drops the `action` key */
const AFTER_DUE = ['remind', ...WF_TIMEOUT_ACTIONS] as const
const afterDue = computed({
  get: () => review.value?.timeout?.action ?? 'remind',
  set: (v: WfTimeoutAction | 'remind') => {
    const timeout = review.value!.timeout!
    if (v === 'remind') delete timeout.action
    else timeout.action = v
  },
})
const repeatOn = computed({
  get: () => review.value?.timeout?.remindEvery != null,
  set: (on) => {
    const timeout = review.value!.timeout!
    if (on) timeout.remindEvery = DAY
    else delete timeout.remindEvery
  },
})
</script>

<template>
  <el-form label-position="top" class="wf-node-settings" @submit.prevent>
    <el-form-item :label="t('wf.designer.drawer.name')">
      <el-input v-model="name" name="name" :maxlength="WF_NAME_MAX" show-word-limit />
    </el-form-item>

    <WfAssigneeEditor v-if="review" v-model="review.assignee" :fields reorder />
    <WfAssigneeEditor v-if="notify" v-model="notify.assignee" :fields />

    <template v-if="review">
      <el-form-item :label="t('wf.designer.review.sign.label')">
        <el-radio-group v-model="review.sign" class="wf-node-settings__stack">
          <el-radio v-for="v in WF_SIGN_MODES" :key="v" :value="v">
            {{ t(`wf.designer.review.sign.${v}`) }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('wf.designer.review.whenNobody.label')">
        <!-- `toManager` here = the process managers; the timeout's `toManager` = the assignee's manager -->
        <el-radio-group
          :model-value="review.whenNobody"
          @change="(v: (typeof WF_WHEN_NOBODY)[number]) => setWhenNobody(v)"
        >
          <el-radio v-for="v in WF_WHEN_NOBODY" :key="v" :value="v">
            {{ t(`wf.designer.review.whenNobody.${v}`) }}
          </el-radio>
        </el-radio-group>
        <UserSelect
          v-if="review.whenNobody === 'toUser'"
          v-model="fallbackUser"
          :label="fallbackUser == null ? null : fallbackNames.get(fallbackUser)"
          class="wf-node-settings__below"
        />
      </el-form-item>
      <el-form-item :label="t('wf.designer.review.whenInitiatorIsReviewer.label')">
        <el-radio-group v-model="review.whenInitiatorIsReviewer">
          <el-radio v-for="v in WF_WHEN_INITIATOR_IS_REVIEWER" :key="v" :value="v">
            {{ t(`wf.designer.review.whenInitiatorIsReviewer.${v}`) }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('wf.designer.review.onReject.label')">
        <el-radio-group v-model="review.onReject">
          <el-radio v-for="v in WF_ON_REJECT" :key="v" :value="v">
            {{ t(`wf.designer.review.onReject.${v}`) }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('wf.designer.review.resubmitTo.label')">
        <el-radio-group
          :model-value="review.resubmitTo ?? 'restart'"
          @change="(v: (typeof WF_RESUBMIT_TO)[number]) => (review!.resubmitTo = v)"
        >
          <el-radio v-for="v in WF_RESUBMIT_TO" :key="v" :value="v">
            {{ t(`wf.designer.review.resubmitTo.${v}`) }}
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item>
        <el-switch
          v-model="review.commentRequired"
          :active-text="t('wf.designer.review.commentRequired')"
          :aria-label="t('wf.designer.review.commentRequired')"
        />
      </el-form-item>
      <el-form-item>
        <el-switch
          v-model="timeoutOn"
          :active-text="t('wf.designer.review.timeout.label')"
          :aria-label="t('wf.designer.review.timeout.label')"
        />
        <div v-if="review.timeout" class="wf-node-settings__timeout">
          <label class="wf-node-settings__inline">
            {{ t('wf.designer.review.timeout.hours') }}
            <el-input-number
              v-model="review.timeout.hours"
              name="hours"
              :min="1"
              :max="WF_TIMEOUT_HOURS_MAX"
              step-strictly
              value-on-clear="min"
              controls-position="right"
            />
          </label>
          <span class="wf-node-settings__inline">
            <el-checkbox v-model="repeatOn">{{
              t('wf.designer.review.timeout.repeat')
            }}</el-checkbox>
            <el-input-number
              v-if="review.timeout.remindEvery != null"
              v-model="review.timeout.remindEvery"
              name="remindEvery"
              :min="1"
              :max="WF_TIMEOUT_HOURS_MAX"
              step-strictly
              value-on-clear="min"
              controls-position="right"
              :aria-label="t('wf.designer.review.timeout.every')"
            />
          </span>
          <div class="wf-node-settings__after">
            <span class="wf-node-settings__inline">{{
              t('wf.designer.review.timeout.after.label')
            }}</span>
            <!-- `toManager` here = the assignee's manager; whenNobody's `toManager` = the process managers -->
            <el-radio-group
              v-model="afterDue"
              :aria-label="t('wf.designer.review.timeout.after.label')"
            >
              <el-radio v-for="v in AFTER_DUE" :key="v" :value="v">
                {{ t(`wf.designer.review.timeout.after.${v}`) }}
              </el-radio>
            </el-radio-group>
          </div>
          <p class="wf-node-settings__hint">
            {{
              review.timeout.action
                ? t(`wf.designer.review.timeout.afterHint.${review.timeout.action}`, {
                    onReject: t(`wf.designer.review.onReject.${review.onReject}`),
                  })
                : t('wf.designer.review.timeout.hint')
            }}
          </p>
          <p v-if="review.timeout.action" class="wf-node-settings__hint">
            {{ t('wf.designer.review.timeout.afterHint.common') }}
          </p>
        </div>
      </el-form-item>
    </template>

    <template v-if="path">
      <p v-if="parallel" class="wf-node-settings__hint">{{ t('wf.designer.summary.parallel') }}</p>
      <p v-else-if="path.fallback" class="wf-node-settings__hint">
        {{ t('wf.designer.path.fallbackHint') }}
      </p>
      <WfCondBuilder v-else v-model="path.when" :fields />
    </template>

    <WfFieldAccess v-if="withAccess" v-model="withAccess.access" :fields />
  </el-form>
</template>

<style scoped>
.wf-node-settings__stack {
  flex-direction: column;
  align-items: flex-start;
}
.wf-node-settings__below {
  margin-top: 8px;
}
.wf-node-settings__timeout {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  width: 100%;
  margin-top: 8px;
}
.wf-node-settings__after {
  display: flex;
  flex-wrap: wrap;
  gap: 0 16px;
  align-items: center;
  width: 100%;
}
.wf-node-settings__inline {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--qw-text-2);
}
.wf-node-settings__hint {
  width: 100%;
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--qw-text-3);
}
</style>
