import { spawnSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
// 当前 classic Vue+nvue 编译器的服务、配置、页面与视图产物，静态图标不能替代它们。
export const APP_OUTPUT_FILES = Object.freeze([
  'app-service.js',
  'app-config.js',
  'app-config-service.js',
  'manifest.json',
  'pages-im/call/index.js',
  'uni-app-view.umd.js',
])

/** CLI 某些失败会返回零；必须逐项确认完整、非空且不借外部链接的真正编译产物。 */
export function assertAppOutput(outputDir) {
  for (const name of APP_OUTPUT_FILES) {
    const file = join(outputDir, name)
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat?.isFile() || stat.size === 0 || !readFileSync(file, 'utf8').trim())
      throw new Error(`Missing or empty App output: ${name}`)
  }
  try {
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8'))
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error()
  } catch {
    throw new Error('Invalid compiled App manifest.json')
  }
}

/** 只构建本应用的固定输出目录；注入执行端口仅用于临时目录回归，不扩展打包目标。 */
export function buildApp(projectDir = mobileDir, runCompiler = spawnSync) {
  const buildDir = join(projectDir, 'dist', 'build')
  for (const parent of [join(projectDir, 'dist'), buildDir]) {
    const stat = lstatSync(parent, { throwIfNoEntry: false })
    if (stat && !stat.isDirectory()) throw new Error('App output parent must be a real directory')
  }
  mkdirSync(buildDir, { recursive: true })
  const outputDir = join(buildDir, 'app')
  // nvue 编译器先写同级暂存目录，再生成 App 页面；一起清理才能拒绝上次残留页面。
  rmSync(outputDir, { recursive: true, force: true })
  rmSync(join(buildDir, '.nvue'), { recursive: true, force: true })
  try {
    const cli = require.resolve('@dcloudio/vite-plugin-uni/bin/uni.js')
    const result = runCompiler(process.execPath, [cli, 'build', '-p', 'app'], {
      cwd: projectDir,
      stdio: 'inherit',
      timeout: 10 * 60_000,
      env: {
        ...process.env,
        UNI_INPUT_DIR: join(projectDir, 'src'),
        UNI_OUTPUT_DIR: outputDir,
        UNI_PLATFORM: 'app',
        UNI_APP_X: 'false',
        UNI_COMPILE_TARGET: '',
      },
    })
    if (result.error) throw new Error('App compiler could not finish', { cause: result.error })
    if (result.signal) throw new Error(`App compiler terminated by ${result.signal}`)
    if (result.status !== 0) throw new Error(`App compiler exited with status ${result.status}`)
    assertAppOutput(outputDir)
    cpSync(join(projectDir, 'unpackage', 'res'), join(outputDir, 'unpackage', 'res'), {
      recursive: true,
    })
    return outputDir
  } catch (error) {
    // 失败不留下可被后续手工打包误用的半成品或仅有静态资源的目录。
    rmSync(outputDir, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/build-app.mjs')
    buildApp()
    console.log('build-app: verified App output and copied package resources.')
  } catch (error) {
    console.error(`build-app: FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
