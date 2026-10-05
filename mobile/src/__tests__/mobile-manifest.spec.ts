// App permissions: the Android package asks only for what the app uses (docs/mobile.md "App 权限"), never the
// DCloud template's defaults (phone state, accounts, logs, system settings…).
import { expect, it } from 'vitest'
import manifest from '../manifest.json?raw'
import pkg from '../../package.json'

const USED = ['ACCESS_NETWORK_STATE', 'ACCESS_WIFI_STATE', 'CAMERA']
const REMOVED = [
  'READ_PHONE_STATE',
  'GET_ACCOUNTS',
  'READ_LOGS',
  'WRITE_SETTINGS',
  'MOUNT_UNMOUNT_FILESYSTEMS',
  'CHANGE_NETWORK_STATE',
  'CHANGE_WIFI_STATE',
  'FLASHLIGHT',
  'VIBRATE',
  'WAKE_LOCK',
]

it('the Android package requests only the permissions the app uses', () => {
  const asked = [...manifest.matchAll(/android\.permission\.(\w+)/g)].map(([, name]) => name)
  for (const name of REMOVED) expect(asked).not.toContain(name)
  expect(asked.sort()).toEqual(USED)
})

type Manifest = Record<string, Record<string, unknown> & { distribute?: Record<string, unknown> }>
// manifest.json carries comments
const json = JSON.parse(manifest.replace(/\/\*[\s\S]*?\*\//g, '')) as Manifest

it('dark mode: App and the mini program follow theme.json; H5 does it in core/theme.ts', () => {
  for (const platform of ['app-plus', 'mp-weixin'])
    expect([platform, json[platform]]).toEqual([
      platform,
      expect.objectContaining({ darkmode: true, themeLocation: 'theme.json' }),
    ])
  // App pages reach under the home indicator: uni's default for a tab bar app leaves an unthemed band there
  expect(json['app-plus']?.safearea).toEqual({ bottom: { offset: 'none' } })
  // uni-h5's darkmode breaks uni.hideTabBar (the themed tab bar is a copy): light theme.json values at build
  expect(json.h5?.darkmode).toBeUndefined()
})

it('iOS: uni.chooseImage has usage strings for the camera and the photo library', () => {
  const { ios } = json['app-plus']!.distribute as { ios?: { privacyDescription?: object } }
  expect(ios?.privacyDescription).toEqual({
    NSCameraUsageDescription: expect.stringMatching(/\S/),
    NSPhotoLibraryUsageDescription: expect.stringMatching(/\S/),
  })
})

it('the App icon and splash point at committed images outside src/static', () => {
  const images = Object.keys(import.meta.glob('../../unpackage/res/**/*.png')).map((p) =>
    p.replace('../../', ''),
  )
  const { icons, splashscreen } = json['app-plus']!.distribute as Record<string, object>
  const paths = JSON.stringify({ icons, splashscreen }).match(/unpackage\/[^"]+/g) ?? []
  // 4 Android + 1 App Store + 9 iPad + 8 iPhone icons, 3 Android splash screens
  expect(paths.length).toBe(25)
  for (const path of paths) expect(images).toContain(path)
  expect(manifest).not.toMatch(/static\/[^"]*\.png/)
})

it('build:app ships them: HBuilderX packs dist/build/app, which uni builds without unpackage/', () => {
  expect(pkg.scripts['build:app']).toBe(
    'uni build -p app && node -e "require(\'node:fs\').cpSync(\'unpackage/res\', \'dist/build/app/unpackage/res\', { recursive: true })"',
  )
})
