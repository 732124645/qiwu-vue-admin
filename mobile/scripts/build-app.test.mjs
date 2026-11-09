import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { APP_OUTPUT_FILES, assertAppOutput, buildApp } from './build-app.mjs'

/** Windows 未授权创建符号链接时沿用平台测试约定跳过，不改变有权限环境的真实断言。 */
function linkForTest(t, target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Symbolic links require local permissions')
      return false
    }
    throw error
  }
}

// 只操作本规格创建的临时工程，执行端口不启动真实编译器、不接触工作树产物或云打包。
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'qiwu-app-build-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const output = join(root, 'dist', 'build', 'app')
  const write = (file, text = 'compiled') => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const compiled = () => {
    for (const name of APP_OUTPUT_FILES)
      write(
        join(output, name),
        name === 'manifest.json' ? '{"name":"fixture","plus":{}}' : '(() => {})();',
      )
  }
  write(join(root, 'src', 'manifest.json'), 'source stays')
  write(join(root, 'unpackage', 'res', 'icons', 'icon.png'), 'icon')
  return { root, output, write, compiled }
}

test('requires every current App artifact and a parsed manifest, rather than static files alone', (t) => {
  const f = fixture(t)
  assert.throws(() => assertAppOutput(f.output), /Missing or empty App output/)
  f.compiled()
  assert.doesNotThrow(() => assertAppOutput(f.output))
  for (const name of APP_OUTPUT_FILES) {
    f.write(join(f.output, name), '')
    assert.throws(() => assertAppOutput(f.output), /Missing or empty App output/)
    f.compiled()
  }
  for (const manifest of ['{', 'null', '[]', '"not a manifest"']) {
    f.write(join(f.output, 'manifest.json'), manifest)
    assert.throws(() => assertAppOutput(f.output), /Invalid compiled App manifest/)
  }
})

test('cleans stale App and nvue output before compiling and preserves source and other platforms', (t) => {
  const f = fixture(t)
  f.compiled()
  const staging = join(f.root, 'dist', 'build', '.nvue', 'old.js')
  const h5 = join(f.root, 'dist', 'build', 'h5', 'keep.js')
  f.write(staging)
  f.write(h5)
  assert.throws(
    () =>
      buildApp(f.root, () => {
        assert.equal(existsSync(join(f.output, 'app-service.js')), false)
        assert.equal(existsSync(staging), false)
        return { status: 0, signal: null }
      }),
    /Missing or empty App output/,
  )
  assert.equal(existsSync(f.output), false)
  assert.equal(readFileSync(join(f.root, 'src', 'manifest.json'), 'utf8'), 'source stays')
  assert.equal(readFileSync(h5, 'utf8'), 'compiled')
})

test('zero exit with only copied static resources cannot pass or leave a misleading App package', (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      buildApp(f.root, () => {
        f.write(join(f.output, 'uni-app-view.umd.js'))
        f.write(join(f.output, 'unpackage', 'res', 'icons', 'old.png'))
        return { status: 0, signal: null }
      }),
    /Missing or empty App output/,
  )
  assert.equal(existsSync(f.output), false)
})

test('nonzero exits, signals and spawn errors fail even if the compiler wrote plausible artifacts', (t) => {
  const f = fixture(t)
  for (const [result, message] of [
    [{ status: 1, signal: null }, /exited with status 1/],
    [{ status: null, signal: 'SIGTERM' }, /terminated by SIGTERM/],
    [{ status: 0, signal: null, error: new Error('spawn failed') }, /could not finish/],
    [{ status: null, signal: null }, /exited with status null/],
  ]) {
    assert.throws(
      () =>
        buildApp(f.root, () => {
          f.compiled()
          return result
        }),
      message,
    )
    assert.equal(existsSync(f.output), false)
  }
})

test('uses the local uni CLI and fixed App target, then copies resources only after validating output', (t) => {
  const f = fixture(t)
  let calls = 0
  const output = buildApp(f.root, (node, args, options) => {
    calls++
    assert.equal(node, process.execPath)
    assert.match(args[0].replaceAll('\\', '/'), /@dcloudio\/vite-plugin-uni\/bin\/uni\.js$/)
    assert.deepEqual(args.slice(1), ['build', '-p', 'app'])
    assert.equal(options.cwd, f.root)
    assert.equal(options.env.UNI_INPUT_DIR, join(f.root, 'src'))
    assert.equal(options.env.UNI_OUTPUT_DIR, f.output)
    assert.equal(options.env.UNI_APP_X, 'false')
    assert.equal(options.env.UNI_COMPILE_TARGET, '')
    assert.equal(existsSync(join(f.output, 'unpackage', 'res')), false)
    f.compiled()
    return { status: 0, signal: null }
  })
  assert.equal(calls, 1)
  assert.equal(output, f.output)
  assert.doesNotThrow(() => assertAppOutput(output))
  assert.equal(readFileSync(join(output, 'unpackage', 'res', 'icons', 'icon.png'), 'utf8'), 'icon')
})

test('copy failures reject the package and remove its incomplete output', (t) => {
  const f = fixture(t)
  rmSync(join(f.root, 'unpackage'), { recursive: true })
  assert.throws(
    () =>
      buildApp(f.root, () => {
        f.compiled()
        return { status: 0, signal: null }
      }),
    /ENOENT/,
  )
  assert.equal(existsSync(f.output), false)
})

test('rejects linked output parents before deleting or compiling outside the project', (t) => {
  for (const name of ['dist', 'dist/build']) {
    const f = fixture(t),
      outside = join(f.root, 'outside')
    mkdirSync(join(outside, 'app'), { recursive: true })
    f.write(join(outside, 'app', 'keep'), 'must survive')
    mkdirSync(dirname(join(f.root, name)), { recursive: true })
    if (!linkForTest(t, outside, join(f.root, name), 'dir')) return
    let compiled = false
    assert.throws(
      () =>
        buildApp(f.root, () => {
          compiled = true
          return { status: 0, signal: null }
        }),
      /App output parent must be a real directory/,
    )
    assert.equal(compiled, false)
    assert.equal(readFileSync(join(outside, 'app', 'keep'), 'utf8'), 'must survive')
  }
})
test('rejects a linked artifact even if the linked target contains plausible compiled code', (t) => {
  const f = fixture(t)
  f.compiled()
  const target = join(f.root, 'outside.js')
  f.write(target, '(() => {})();')
  const artifact = join(f.output, 'app-service.js')
  rmSync(artifact)
  if (!linkForTest(t, target, artifact)) return
  assert.throws(() => assertAppOutput(f.output), /Missing or empty App output/)
})
