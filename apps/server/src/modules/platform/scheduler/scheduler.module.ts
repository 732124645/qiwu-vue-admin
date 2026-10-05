import { Module } from '@nestjs/common'
import { RunModule } from './run/run.module.js'
import { TaskModule } from './task/task.module.js'

/** Scheduled jobs: the task and run log pages over the scheduler engine. */
@Module({ imports: [TaskModule, RunModule] })
export class SchedulerModule {}
