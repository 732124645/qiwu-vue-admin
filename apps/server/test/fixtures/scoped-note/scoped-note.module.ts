import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ScopedNoteController } from './scoped-note.controller.js'
import { ScopedNote } from './scoped-note.entity.js'
import { ScopedNoteService } from './scoped-note.service.js'
import { TestDept } from './test-dept.entity.js'

/** Imported by specs that need the scoped-note fixture (after CoreContextModule + CoreDbModule). */
@Module({
  imports: [TypeOrmModule.forFeature([ScopedNote, TestDept])],
  controllers: [ScopedNoteController],
  providers: [ScopedNoteService],
  exports: [ScopedNoteService],
})
export class ScopedNoteFixtureModule {}
