import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { pageQuery } from '@qiwu/shared'
import { z } from 'zod'
import { RequirePerm } from '../../../src/core/auth/decorators.js'
import { ScopedNoteService } from './scoped-note.service.js'

export const notePerms = {
  browse: 'test.note.browse',
  view: 'test.note.view',
  create: 'test.note.create',
  modify: 'test.note.modify',
  remove: 'test.note.remove',
  export: 'test.note.export',
} as const

const noteQuery = pageQuery(['id', 'title'])
type NoteQuery = z.output<typeof noteQuery>
const noteBody = z.object({
  title: z.string().min(1).max(100),
  deptId: z.number().int().positive().nullable().optional(),
})
const noteUpdate = noteBody.partial()
const idsBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) })

/** The routes a generated CRUD controller has (see docs/design-notes.md#api-envelope), over the data-scoped fixture entity. */
@Controller('test/scoped-notes')
export class ScopedNoteController {
  constructor(private readonly notes: ScopedNoteService) {}

  @Get()
  @RequirePerm(notePerms.browse)
  list(@Query({ schema: noteQuery }) query: NoteQuery) {
    return this.notes.page(query)
  }

  @Get('options')
  @RequirePerm(notePerms.browse)
  options() {
    return this.notes.options()
  }

  @Get('export')
  @RequirePerm(notePerms.export)
  async exportRows(@Query({ schema: noteQuery }) query: NoteQuery) {
    const rows = []
    for await (const batch of this.notes.exportRows(query)) rows.push(...batch)
    return rows
  }

  /** Any-of, listed narrow perm first: the scope must not follow the declaration order. */
  @Get('any-of')
  @RequirePerm(notePerms.view, notePerms.browse)
  anyOf() {
    return this.notes.options()
  }

  @Get(':id')
  @RequirePerm(notePerms.view)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.notes.get(id)
  }

  @Post()
  @RequirePerm(notePerms.create)
  create(@Body({ schema: noteBody }) dto: z.output<typeof noteBody>) {
    return this.notes.create(dto)
  }

  @Put(':id')
  @RequirePerm(notePerms.modify)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: noteUpdate }) dto: z.output<typeof noteUpdate>,
  ) {
    return this.notes.update(id, dto)
  }

  /** A write needing two perms: the scope is the intersection of both perms' scopes. */
  @Put(':id/strict')
  @RequirePerm.all(notePerms.browse, notePerms.modify)
  strictUpdate(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: noteUpdate }) dto: z.output<typeof noteUpdate>,
  ) {
    return this.notes.update(id, dto)
  }

  @Delete(':id')
  @RequirePerm(notePerms.remove)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.notes.remove([id])
  }

  @Post('batch-delete')
  @HttpCode(200)
  @RequirePerm(notePerms.remove)
  batchRemove(@Body({ schema: idsBody }) body: z.output<typeof idsBody>) {
    return this.notes.remove(body.ids)
  }
}
