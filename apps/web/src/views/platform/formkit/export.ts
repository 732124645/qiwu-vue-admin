import type { FormSchema } from '@qiwu/shared'
import type { CodeFile } from '@/core/components/CodeViewer.vue'

// JSON as a script literal: `<` escaped, so a text such as `</script>` cannot end the SFC's script block
const literal = (value: unknown) => JSON.stringify(value, null, 2).replace(/</g, '\\u003c')

/** Our small SFC template (see docs/design-notes.md#workflow): form-create with our `qw-*` components, in the app language. */
const sfc = ({ rule, option = {} }: FormSchema) => `<script setup lang="ts">
import { ref } from 'vue'
import { formLocale } from '@/core/i18n'
import { installFormCreate } from '@/views/platform/formkit/widgets'

installFormCreate()
const rule = ref(${literal(rule)})
const option = ref(${literal(option)})
const data = ref<Record<string, unknown>>({})
</script>

<template>
  <form-create v-model="data" :rule="rule" :option="option" :locale="formLocale" />
</template>
`

/**
 * The form's export (see docs/design-notes.md#workflow), from a schema `sanitizeFormSchema` returned: `form.json` (the
 * schema `{ rule, option }`, what saving keeps) and `form.vue` (a page component rendering it).
 */
export const formFiles = (schema: FormSchema): CodeFile[] => [
  { path: 'form.json', content: `${JSON.stringify(schema, null, 2)}\n` },
  { path: 'form.vue', content: sfc(schema) },
]
