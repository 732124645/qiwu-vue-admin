import { Module } from '@nestjs/common'
import { AppVersionModule } from './app-version/app-version.module.js'
import { DictEntryModule } from './dict-entry/dict-entry.module.js'
import { DictModule } from './dict/dict.module.js'
import { ParameterModule } from './param/param.module.js'
import { SettingsReadController } from './settings-read.controller.js'

/**
 * Dictionaries and runtime parameters: the read endpoints every client uses (services and caches in
 * core/settings) and the admin pages' CRUD modules; App versions and the App's update check.
 */
@Module({
  imports: [DictModule, DictEntryModule, ParameterModule, AppVersionModule],
  controllers: [SettingsReadController],
})
export class SettingsModule {}
