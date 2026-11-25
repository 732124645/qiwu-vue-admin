// #ifdef APP-PLUS
import * as sdk from '@/uni_modules/qw-livekit'
import { createNativeImMediaPort, type NativeImSdk } from './media-native-port'
import { installImMedia, unavailableImMedia } from './media'

let initialized = false
/** 生命周期入口只执行一次，缺少插件的旧基座不在用户未操作时弹权限或错误。 */
export function initializeNativeImMedia(): void {
  if (initialized) return
  initialized = true
  try {
    installImMedia(createNativeImMediaPort(sdk as NativeImSdk))
  } catch {
    unavailableImMedia()
  }
}
// #endif
