# Android 原生验证工程

从仓库根目录运行 `pnpm mobile:native:android`。入口复制当前 Kotlin、Manifest 与测试源到临时目录，以真实 Android SDK/官方 LiveKit SDK 编译 instrumentation APK，再在本次独立创建的 AOSP Android 35 模拟器上运行。SDK 端口在测试中可控，Android 主线程、View、协程和资源释放保持真实；通过不代表 UTS 宿主链接、App 安装签名、真实 SFU/TURN 或真机媒体互通。

入口需要 JDK 17、Gradle 8.9、Android SDK Platform 35、Build Tools 35.0.0、Platform Tools、Emulator、Command-line Tools，以及当前主机对应的 `system-images;android-35;default;arm64-v8a` 或 `x86_64`。默认使用 `~/.cache/qiwu-native` 中已安装的独立工具，`JAVA_HOME` 优先于 macOS Homebrew JDK 17；可用 `QW_NATIVE_ANDROID_SDK`、`QW_NATIVE_GRADLE` 指定工具路径。脚本不安装 SDK、不接受新的工具许可、不修改全局 Java/SDK 配置。

每次使用随机 AVD 名称、临时 Android user/AVD 目录、私有 ADB 5039 与模拟器 5588/5589。端口占用立即拒绝；不会操作已有模拟器、手机或默认 ADB 5037。所有成功、失败、超时和 SIGINT/SIGTERM 路径均清理本次进程组和 AVD。日志、源副本、APK、完整 resolved dependency classpath 与逐测试结果保留在输出的临时证据目录。

验收从当前 Kotlin 源读取至少 30 个唯一 `@Test` 方法名，并逐一核对实际 instrumentation 的开始/成功状态、JUnit 总数和最终 instrumentation 结果。空执行、未知/重复方法、失败、跳过、测试崩溃或缺少摘要均失败，不能用 APK 生成或进程返回 0 代替。

固定构建依赖为 AGP 8.7.2、Kotlin Android plugin 1.9.25、LiveKit Android 2.30.0、kotlinx-coroutines-android 1.6.4、AndroidX test runner 1.6.2/ext.junit 1.2.1 和 JUnit 4.13.2。JUnit 为仅 instrumentation 使用的 EPL-1.0 测试依赖，其他直接依赖使用 Apache-2.0；正式宿主的许可结论另行核对。JitPack 仓库严格限制为官方 SDK 所需的 `com.github.davidliu` group，不排除 SDK 的 JAIN、FFI、WebRTC 或其他必需制品。

LiveKit Android 候选图中的 `android-jain-sip-ri` 分发许可仍待 [官方议题](https://github.com/livekit/client-sdk-android/issues/1048) 澄清。此工程只执行本地验证；私有宿主接入配置与公开打包分发是两项决定，不把 SDK 本体 Apache-2.0 当作完整传递图的分发授权。
