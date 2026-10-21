import { extname } from 'node:path'
import { Global, Injectable, Logger, Module } from '@nestjs/common'
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm'
import { Err, STORAGE_IMAGE_MIMES } from '@qiwu/shared'
import { In, type Repository } from 'typeorm'
import {
  ATTACHMENT_SOURCE,
  type AttachmentSource,
  type ResolvedAttachment,
} from '../../../core/agent/agent-ports.js'
import type { Principal } from '../../../core/auth/principal.js'
import { importParts } from '../../../core/excel/excel.js'
import { cellText, firstSheetRows } from '../../../core/excel/excel.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { FsObject } from './fs-object.entity.js'
import { StorageModule } from './storage.module.js'
import { StorageService } from './storage.service.js'

/** 一条消息最多附带的文件数。 */
export const ATTACH_MAX_FILES = 10
/** 每个文本附件（及表格转成的 CSV）交给模型的最多字节 / 字符数，超出部分截断。 */
export const ATTACH_TEXT_MAX = 200 * 1024
/** 图片与表格文件本身的上限：更大的只告诉模型文件名。 */
export const ATTACH_BINARY_MAX = 5 * 1024 * 1024

const TEXT_EXTS = new Set(['txt', 'md', 'csv', 'json', 'log'])
const XLSX_EXT = 'xlsx'

const truncatedNote = (size: number) =>
  `\n[truncated: the file has ${size} bytes, only the first ${ATTACH_TEXT_MAX} are included]`

/**
 * 文本解码：先按 UTF-8 严格解码，不合法时按 GBK（国内 Windows 常见的 CSV、TXT）。`stream: true`
 * 让截断处被切开的多字节字符不算错误（尾部残字直接丢掉）。
 */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true })
  } catch {
    return new TextDecoder('gbk').decode(buf, { stream: true })
  }
}

/** CSV 的一个单元格：含逗号、引号或换行时加引号。 */
// 正则里的引号写成 \x22：i18n 检查的注释剥离不认识正则字面量
const csvCell = (s: string) => (/[,\r\n\x22]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)

/**
 * 智能体消息附件的存储侧实现（see docs/agent.md）：按发送人的身份取文件，规则与下载路由相同
 * （`StorageService.canRead`，查询带租户条件），不存在或无权读取的一律 404，不暴露文件是否存在。
 * 文本类（txt、md、csv、json、log）最多取前 200 KB；png / jpeg / webp / gif 图片 5 MB 以内转成
 * data URL；xlsx 取第一张表转成 CSV（同样 200 KB）；其余类型只给文件名。
 */
@Injectable()
export class AgentAttachments implements AttachmentSource {
  private readonly logger = new Logger(AgentAttachments.name)

  constructor(
    @InjectRepository(FsObject) private readonly objects: Repository<FsObject>,
    private readonly storage: StorageService,
  ) {}

  /** 按 `fileIds` 的顺序解析附件（重复的 id 只算一次）；任何一个读不到就整条 404。 */
  async resolve(p: Principal, fileIds: number[]): Promise<ResolvedAttachment[]> {
    const ids = [...new Set(fileIds)]
    if (ids.length > ATTACH_MAX_FILES) throw new BizError(Err.UNPROCESSABLE)
    if (!ids.length) return []
    // ORM 的租户条件：其他租户的文件查不到；软删除的同样查不到
    const rows = new Map((await this.objects.findBy({ id: In(ids) })).map((o) => [Number(o.id), o]))
    const objs: FsObject[] = []
    for (const id of ids) {
      const obj = rows.get(id)
      if (!obj || !(await this.storage.canRead(obj, p))) throw new BizError(Err.NOT_FOUND)
      objs.push(obj)
    }
    const out: ResolvedAttachment[] = []
    for (const obj of objs) out.push(await this.read(obj))
    return out
  }

  /** 读一个已确认可读的文件并按类型转换；读取失败（文件丢失、表格损坏）时降级为只给文件名。 */
  private async read(obj: FsObject): Promise<ResolvedAttachment> {
    const meta = {
      fileId: Number(obj.id),
      name: obj.originalName,
      mime: obj.mime,
      size: Number(obj.size),
    }
    const unsupported: ResolvedAttachment = { meta, kind: 'unsupported' }
    const ext = extname(obj.originalName).slice(1).toLowerCase()
    try {
      if ((STORAGE_IMAGE_MIMES as readonly string[]).includes(obj.mime)) {
        if (meta.size > ATTACH_BINARY_MAX) return unsupported
        const data = await this.storage.readHead(obj, ATTACH_BINARY_MAX)
        if (!data) return unsupported
        return {
          meta,
          kind: 'image',
          imageDataUrl: `data:${obj.mime};base64,${data.toString('base64')}`,
        }
      }
      if (TEXT_EXTS.has(ext)) {
        const data = await this.storage.readHead(obj, ATTACH_TEXT_MAX)
        if (!data) return unsupported
        const text = decodeText(data)
        return {
          meta,
          kind: 'text',
          text: meta.size > ATTACH_TEXT_MAX ? text + truncatedNote(meta.size) : text,
        }
      }
      if (ext === XLSX_EXT && meta.size <= ATTACH_BINARY_MAX) {
        const data = await this.storage.readHead(obj, ATTACH_BINARY_MAX)
        const text = data && (await sheetCsv(data))
        return text === null ? unsupported : { meta, kind: 'text', text }
      }
    } catch (e) {
      // 只记类型，不记内容：附件降级为文件名，这一轮照常进行
      this.logger.warn(
        { fileId: meta.fileId, err: e instanceof Error ? e.name : 'Error' },
        'attachment read failed',
      )
    }
    return unsupported
  }
}

/**
 * xlsx 第一张表 → CSV 文本，最多 {@link ATTACH_TEXT_MAX} 个字符（超出截断并注明）。先过导入的 zip 检查
 * （压缩炸弹、宏、外部链接），不合格返回 null；表格按流读取，够长就停，不会整本载入内存。
 */
async function sheetCsv(buf: Buffer): Promise<string | null> {
  const parts = await importParts(buf, ATTACH_BINARY_MAX * 20)
  if (!Array.isArray(parts)) return null
  const lines: string[] = []
  let length = 0
  for await (const row of firstSheetRows(parts)) {
    if (!row.hasValues) continue
    const cells: string[] = []
    for (let n = 1; n <= row.cellCount; n++) cells.push(csvCell(cellText(row.getCell(n).value)))
    const line = cells.join(',')
    lines.push(line)
    length += line.length + 1
    if (length > ATTACH_TEXT_MAX)
      return `${lines.join('\n').slice(0, ATTACH_TEXT_MAX)}\n[truncated: only the first ${ATTACH_TEXT_MAX} characters of the first sheet are included]`
  }
  return lines.join('\n')
}

/**
 * 把附件来源以全局令牌提供给智能体（core 不引用 modules，见分层规则）：AgentModule 以 `@Optional()`
 * 注入 `ATTACHMENT_SOURCE`，没有本模块时消息不能带文件。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FsObject]), StorageModule],
  providers: [AgentAttachments, { provide: ATTACHMENT_SOURCE, useExisting: AgentAttachments }],
  exports: [ATTACHMENT_SOURCE],
})
export class AgentAttachmentsModule {}
