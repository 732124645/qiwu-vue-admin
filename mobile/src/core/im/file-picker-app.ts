// #ifdef APP-PLUS
// App 选任意文件发送（无插件、无新依赖、无需自定义基座）：uni-app-plus 运行时没有任意文件选择，这里用
// Native.js 调系统选择器。Android：`Intent.ACTION_OPEN_DOCUMENT`（CATEGORY_OPENABLE，*/*）经主 Activity 的
// `onActivityResult` 取 content:// URI；iOS：`UIDocumentPickerViewController`（public.item，导入即复制）经
// `plus.ios.implements` 的代理取文件 URL。两端都先按显示名检查扩展名、按大小检查上限，通过后才复制进
// `_doc/im-outbox/<id>-<安全文件名>`；取消不留文件，复制中超限删除半成品。真机核对项见 docs/mobile.md。
import type { ImOptions } from '@qiwu/shared'
import type { ImOutboxFile } from '@qiwu/shared/im-client'
import {
  OUTBOX_DIR,
  checkPick,
  guessMime,
  nameFromUri,
  outboxPath,
  rememberOutboxCopy,
  safeFileName,
  type PickRejection,
} from './file-pick'

// Native.js 对象没有可用的静态类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Native = any
/** Native.js 的 invoke 接受任意个参数（类型声明只写了一个） */
const androidInvoke = (...args: unknown[]): Native =>
  (plus.android.invoke as unknown as (...a: unknown[]) => Native)(...args)
const iosInvoke = (...args: unknown[]): Native =>
  (plus.ios.invoke as unknown as (...a: unknown[]) => Native)(...args)
type Limits = Pick<ImOptions, 'fileExts' | 'imageExts' | 'fileMaxMb'>
type Result = ImOutboxFile | PickRejection | null

/** 本次选择在 onActivityResult 里的请求码（与应用其它 Native.js 调用区分）。 */
const REQUEST_CODE = 0x7177
const CHUNK = 64 * 1024

const newId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** App：选一个文件，检查后复制进发件箱目录。 */
export function pickAppFile(limits: Limits): Promise<Result> {
  return plus.os.name === 'iOS' ? pickIos(limits) : pickAndroid(limits)
}

/** 名字与大小的检查（大小未知时先放过，复制时按字节数再卡）。 */
function precheck(name: string, size: number, limits: Limits): PickRejection | null {
  return checkPick({ name, size: size >= 0 ? size : 1 }, limits)
}

function done(name: string, size: number, path: string): ImOutboxFile {
  rememberOutboxCopy(path)
  return { name: safeFileName(name), size, mime: guessMime(name), localRef: path }
}

// ---------- Android ----------

function pickAndroid(limits: Limits): Promise<Result> {
  return new Promise((resolve) => {
    const main: Native = plus.android.runtimeMainActivity()
    const Intent: Native = plus.android.importClass('android.content.Intent')
    const intent: Native = new Intent(Intent.ACTION_OPEN_DOCUMENT)
    intent.addCategory(Intent.CATEGORY_OPENABLE)
    intent.setType('*/*')
    const previous = main.onActivityResult
    main.onActivityResult = (code: number, result: number, data: Native) => {
      // 别的 Native.js 调用的结果照旧交给原处理
      if (code !== REQUEST_CODE) return previous?.(code, result, data)
      main.onActivityResult = previous
      try {
        const Activity: Native = plus.android.importClass('android.app.Activity')
        if (result !== Activity.RESULT_OK || !data) return resolve(null)
        plus.android.importClass(data)
        resolve(copyAndroid(main, data.getData(), limits))
      } catch {
        resolve('type')
      }
    }
    main.startActivityForResult(intent, REQUEST_CODE)
  })
}

/** 查 OpenableColumns 的显示名与大小，检查后按块复制；超限删半成品。 */
function copyAndroid(main: Native, uri: Native, limits: Limits): Result {
  const resolver: Native = main.getContentResolver()
  plus.android.importClass(resolver)
  let name = ''
  let size = -1
  const cursor: Native = resolver.query(uri, null, null, null, null)
  if (cursor) {
    plus.android.importClass(cursor)
    if (cursor.moveToFirst()) {
      const ni = cursor.getColumnIndex('_display_name')
      const si = cursor.getColumnIndex('_size')
      if (ni >= 0) name = String(cursor.getString(ni) ?? '')
      if (si >= 0 && !cursor.isNull(si)) size = Number(cursor.getLong(si))
    }
    cursor.close()
  }
  if (!name) name = nameFromUri(String(androidInvoke(uri, 'toString')))
  const bad = precheck(name, size, limits)
  if (bad) return bad

  const path = outboxPath(newId(), name)
  const target = plus.io.convertLocalFileSystemURL(path)
  const File: Native = plus.android.importClass('java.io.File')
  const FileOutputStream: Native = plus.android.importClass('java.io.FileOutputStream')
  const ByteClass: Native = plus.android.importClass('java.lang.Byte')
  const file: Native = new File(target)
  file.getParentFile().mkdirs()
  const input: Native = resolver.openInputStream(uri)
  plus.android.importClass(input)
  const out: Native = new FileOutputStream(file)
  const buf: Native = androidInvoke('java.lang.reflect.Array', 'newInstance', ByteClass.TYPE, CHUNK)
  const max = limits.fileMaxMb * 1024 * 1024
  let total = 0
  try {
    for (;;) {
      const n = Number(input.read(buf))
      if (n < 0) break
      total += n
      if (total > max) break
      out.write(buf, 0, n)
    }
  } catch (e) {
    // 读写中途出错（来源被撤销、空间不足）：半成品不留在发件箱目录
    out.close()
    file.delete()
    throw e
  } finally {
    input.close()
    out.close()
  }
  if (total > max || total === 0) {
    file.delete()
    return total === 0 ? 'empty' : 'size'
  }
  return done(name, total, path)
}

/**
 * App：把系统给的临时文件（`chooseImage` 的临时路径随时会被系统清理）复制进发件箱目录并记下，返回副本
 * 路径；发送成功或过期后副本照常删除。
 */
export function copyIntoOutbox(source: string, name: string): Promise<string> {
  const path = outboxPath(newId(), name)
  const fileName = path.slice(OUTBOX_DIR.length)
  // '_doc/im-outbox/' → 根 '_doc/' 与子目录 'im-outbox'
  const [root, sub] = OUTBOX_DIR.split('/')
  return new Promise((resolve, reject) =>
    plus.io.resolveLocalFileSystemURL(
      source,
      (entry) =>
        plus.io.resolveLocalFileSystemURL(
          `${root}/`,
          (doc) =>
            doc.getDirectory(
              sub,
              { create: true },
              (dir) =>
                entry.copyTo(
                  dir,
                  fileName,
                  () => {
                    rememberOutboxCopy(path)
                    resolve(path)
                  },
                  reject,
                ),
              reject,
            ),
          reject,
        ),
      reject,
    ),
  )
}

// ---------- iOS ----------

function pickIos(limits: Limits): Promise<Result> {
  return new Promise((resolve) => {
    let delegate: Native = null
    const finish = (r: Result) => {
      if (delegate) plus.ios.deleteObject(delegate)
      delegate = null
      resolve(r)
    }
    const picked = (url: Native) => {
      try {
        finish(url ? copyIos(url, limits) : null)
      } catch {
        finish('type')
      }
    }
    delegate = plus.ios.implements('UIDocumentPickerDelegate', {
      'documentPicker:didPickDocumentsAtURLs:': (_c: Native, urls: Native) =>
        picked(iosInvoke(urls, 'firstObject')),
      // iOS 11 之前只有单个
      'documentPicker:didPickDocumentAtURL:': (_c: Native, url: Native) => picked(url),
      'documentPickerWasCancelled:': () => finish(null),
    })
    // UIDocumentPickerModeImport = 0：系统把文件复制进应用的临时收件箱
    const picker: Native = iosInvoke(
      plus.ios.newObject('UIDocumentPickerViewController'),
      'initWithDocumentTypes:inMode:',
      ['public.item'],
      0,
    )
    iosInvoke(picker, 'setDelegate:', delegate)
    const app: Native = iosInvoke('UIApplication', 'sharedApplication')
    const root: Native = iosInvoke(iosInvoke(app, 'keyWindow'), 'rootViewController')
    iosInvoke(root, 'presentViewController:animated:completion:', picker, true, null)
  })
}

/** 读系统给的导入副本：检查后移进发件箱目录（同一卷，复制后删系统副本）。 */
function copyIos(url: Native, limits: Limits): Result {
  const source = String(iosInvoke(url, 'path'))
  const name = String(iosInvoke(url, 'lastPathComponent') ?? '') || nameFromUri(source)
  const fm: Native = iosInvoke('NSFileManager', 'defaultManager')
  const attrs: Native = iosInvoke(fm, 'attributesOfItemAtPath:error:', source, null)
  const sizeNum: Native = attrs ? iosInvoke(attrs, 'objectForKey:', 'NSFileSize') : null
  const size = sizeNum ? Number(iosInvoke(sizeNum, 'longLongValue')) : -1
  const bad = precheck(name, size, limits) ?? (size > 0 ? null : 'empty')
  if (bad) {
    iosInvoke(fm, 'removeItemAtPath:error:', source, null)
    return bad
  }
  const path = outboxPath(newId(), name)
  const target = plus.io.convertLocalFileSystemURL(path)
  const dir = target.slice(0, target.lastIndexOf('/'))
  iosInvoke(fm, 'createDirectoryAtPath:withIntermediateDirectories:attributes:error:', dir, true, null, null)
  const ok = iosInvoke(fm, 'copyItemAtPath:toPath:error:', source, target, null)
  iosInvoke(fm, 'removeItemAtPath:error:', source, null)
  if (!ok) return 'type'
  return done(name, size, path)
}
// #endif
