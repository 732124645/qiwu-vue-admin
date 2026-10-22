import { extname } from 'node:path'
import { Global, Injectable, Logger, Module, NotFoundException } from '@nestjs/common'
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm'
import { Err, STORAGE_IMAGE_MIMES } from '@qiwu/shared'
import { In, Like, type Repository } from 'typeorm'
import {
  AGENT_IMAGE_STORE,
  ATTACHMENT_SOURCE,
  type AgentImageStore,
  type AgentStoredImage,
  type AttachmentSource,
  type ResolvedAttachment,
} from '../../../core/agent/agent-ports.js'
import { imageSize } from '../../../core/agent/runtime/image-size.js'
import type { Principal } from '../../../core/auth/principal.js'
import { importParts } from '../../../core/excel/excel.js'
import { cellText, firstSheetRows } from '../../../core/excel/excel.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { FsObject } from './fs-object.entity.js'
import { StorageModule } from './storage.module.js'
import { AGENT_IMAGE_TAG, StorageService } from './storage.service.js'

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
 * 智能体生成的图片的存储侧实现（see docs/agent.md）：私有文件，上传人是发起人本人（按下载路由的规则只有本人、
 * root 与有 `storage.object.view` 的人能读），`bizRef` 是调用键；查找带租户条件（ORM）并限定本人。
 */
@Injectable()
export class AgentImages implements AgentImageStore {
  constructor(
    @InjectRepository(FsObject) private readonly objects: Repository<FsObject>,
    private readonly storage: StorageService,
  ) {}

  /** 按调用键找本人已存的那张图片（调用重做时复用），宽高从文件头读出。 */
  async find(p: Principal, key: string): Promise<AgentStoredImage | null> {
    const obj = await this.objects.findOneBy({
      bizTag: AGENT_IMAGE_TAG,
      bizRef: refOf(key),
      uploaderId: p.userId,
    })
    if (!obj) return null
    const head = await this.storage.readHead(obj, IMAGE_HEAD).catch(() => null)
    const size = head && imageSize(head)
    return { fileId: Number(obj.id), ...(size && { size }) }
  }

  /** 存一张图片，记在本人名下（不是图片的 422，不建文件）。 */
  async save(
    p: Principal,
    key: string,
    image: { data: Buffer; name: string },
  ): Promise<AgentStoredImage> {
    const vo = await this.storage.putAgentImage(image.data, image.name, refOf(key), p.userId)
    const size = imageSize(image.data)
    return { fileId: vo.id, ...(size && { size }) }
  }

  /**
   * 会话被删除或撤回一轮时删掉它生成的图片（软删，与文件页删除同一条路径）：调用键 `<会话 id>:<调用 id>`，
   * 给出 `callIds` 时只删这些调用的。会话 id 与冒号里没有 LIKE 通配符；查找带租户条件（ORM）。已被别处删掉的跳过。
   */
  async drop(threadId: number, callIds?: string[]): Promise<void> {
    if (callIds && !callIds.length) return
    const bizRef = callIds
      ? In(callIds.map((c) => refOf(`${threadId}:${c}`)))
      : Like(`${refOf(`${threadId}:`)}%`)
    const rows = await this.objects.find({
      where: { bizTag: AGENT_IMAGE_TAG, bizRef },
      select: { id: true, bizRef: true },
    })
    for (const o of rows)
      await this.storage
        .remove(Number(o.id), { bizTag: AGENT_IMAGE_TAG, bizRef: o.bizRef ?? '' })
        .catch((e: unknown) => {
          if (!(e instanceof NotFoundException)) throw e
        })
  }
}

/** 读图片宽高时最多看的文件头字节数。 */
const IMAGE_HEAD = 64 * 1024
/** 调用键 → `biz_ref`（最长 64）。 */
const refOf = (key: string) => `agent:${key}`.slice(0, 64)

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
 * 把附件来源与图片存放处以全局令牌提供给智能体（core 不引用 modules，见分层规则）：AgentModule 以 `@Optional()`
 * 注入 `ATTACHMENT_SOURCE`，没有本模块时消息不能带文件。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([FsObject]), StorageModule],
  providers: [
    AgentAttachments,
    { provide: ATTACHMENT_SOURCE, useExisting: AgentAttachments },
    AgentImages,
    { provide: AGENT_IMAGE_STORE, useExisting: AgentImages },
  ],
  exports: [ATTACHMENT_SOURCE, AGENT_IMAGE_STORE],
})
export class AgentAttachmentsModule {}
