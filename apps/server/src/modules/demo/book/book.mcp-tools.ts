import { Injectable, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { z } from 'zod'
import { McpTool } from '../../../core/mcp/mcp-tool.js'
import { Book } from './book.entity.js'
import { BookService } from './book.service.js'

// Only what the agent may set, bounded like the create route's body; written out here (not the shared
// `bookCreate`) so the generator's other variants of the sample (read-only, …) still compile with this file.
const createInput = z.object({
  isbn: z.string().trim().min(1).max(20).describe('the ISBN, unique among the books'),
  title: z.string().trim().min(1).max(200),
  author: z.string().trim().max(100).optional(),
  genre: z
    .string()
    .trim()
    .min(1)
    .max(16)
    .describe('a value of the dictionary demo.genre (see cfg.dict.options), e.g. fiction'),
  deptId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('the owning department; must be one the caller may write'),
})

const createdOutput = z.object({
  id: z.number().int(),
  isbn: z.string(),
  title: z.string(),
  genre: z.string(),
})

/**
 * 示例图书的写入类 MCP 工具（see docs/mcp.md）：演示写入类声明。走 `BookService.create`，所以数据权限
 * （部门）、唯一性、引用检查与创建人都和页面上新建一样；底座另记一条 `mcp.tool` / `call` 操作日志
 * （含结果）。
 */
@Injectable()
export class BookMcpTools {
  constructor(private readonly books: BookService) {}

  @McpTool({
    name: 'demo.book.create',
    title: 'Create a book',
    description:
      'Adds a book to the sample library: ISBN, title and genre are required. Returns the new ' +
      'book’s id.',
    // bookPerms.create (a literal for the same reason as the schema above)
    perm: 'demo.book.create',
    kind: 'write',
    input: createInput,
    output: createdOutput,
  })
  async create(dto: z.output<typeof createInput>): Promise<z.input<typeof createdOutput>> {
    const b = await this.books.create(dto)
    return { id: Number(b.id), isbn: b.isbn, title: b.title, genre: b.genre }
  }
}

/** 生成的图书模块之外单独装配（生成文件保持与生成器一致）：自带一个 BookService 实例。 */
@Module({
  imports: [TypeOrmModule.forFeature([Book])],
  providers: [BookService, BookMcpTools],
})
export class BookMcpModule {}
