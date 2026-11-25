// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "QwLiveKitNative",
    platforms: [.iOS(.v15)],
    products: [.library(name: "QwLiveKitNative", targets: ["QwLiveKitNative"])],
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.19.0"),
    ],
    targets: [
        .target(
            name: "QwLiveKitNative",
            dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")],
            path: "utssdk/app-ios",
            exclude: ["config.json", "index.uts", "index.vue", "Info.plist"],
            sources: ["hybrid.swift"],
            resources: [.copy("Resources")]
        ),
        .testTarget(name: "QwLiveKitNativeTests", dependencies: ["QwLiveKitNative"], path: "native-tests/ios/Tests"),
    ],
    swiftLanguageModes: [.v5]
)
