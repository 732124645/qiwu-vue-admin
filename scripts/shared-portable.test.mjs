import assert from 'node:assert/strict'
import test from 'node:test'
import check from './arch/shared-portable.mjs'

const run = (sources) =>
  check({
    files: () => Object.keys(sources),
    read: (file) => {
      if (file === 'packages/shared/tsconfig.json') return '{"compilerOptions":{"types":[]}}'
      if (!Object.hasOwn(sources, file)) throw new Error(`Missing fixture: ${file}`)
      return sources[file]
    },
  })

test('media dependency exceptions are confined to the audited browser files', () => {
  assert.deepEqual(
    run({
      'packages/shared/src/platform/im/media/browser.ts': "import { Room } from 'livekit-client'",
      'packages/shared/src/platform/im/media/voice.ts':
        "import Recorder from 'recorder-core'; import 'recorder-core/src/engine/wav.js'",
      'packages/shared/src/platform/im/client/engine.ts':
        "import { sha256 } from '@noble/hashes/sha256'; import { encode } from '@stablelib/utf8'",
    }),
    [],
  )
  assert.equal(
    run({ 'packages/shared/src/unrelated.ts': "import { Room } from 'livekit-client'" }).length,
    1,
  )
  assert.equal(
    run({ 'packages/shared/src/platform/im/media/browser.ts': "import fs from 'node:fs'" }).length,
    1,
  )
})

test('root and portable client cannot value-export the browser entry', () => {
  for (const file of ['packages/shared/src/index.ts', 'packages/shared/src/im-client.ts']) {
    assert.equal(run({ [file]: "export * from './platform/im/media/browser.js'" }).length, 1)
    assert.deepEqual(
      run({ [file]: "export type { ImMediaPort } from './platform/im/media/types.js'" }),
      [],
    )
  }
})
