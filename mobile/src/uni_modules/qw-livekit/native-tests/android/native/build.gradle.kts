plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

val pluginSource = rootProject.projectDir.resolve("../..")

android {
    namespace = "io.qiwu.livekit.nativeharness"
    testNamespace = "io.qiwu.livekit.nativeharness.test"
    compileSdk = 35
    buildToolsVersion = "35.0.0"

    defaultConfig {
        minSdk = 21
        targetSdk = 35
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    sourceSets {
        getByName("main") {
            java.setSrcDirs(listOf(pluginSource.resolve("utssdk/app-android")))
            manifest.srcFile(pluginSource.resolve("utssdk/app-android/AndroidManifest.xml"))
        }
        getByName("androidTest") {
            java.setSrcDirs(listOf(rootProject.projectDir.resolve("src/androidTest/java")))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    // 仅本地原生验证，完整传递图保留；这不构成宿主 App 的分发许可放行。
    implementation("io.livekit:livekit-android:2.30.0")
    // 桥直接使用协程类型，不能依赖 SDK 的 runtime-only 声明提供编译类路径。
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.6.4")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("junit:junit:4.13.2")
}

tasks.register("writeDependencyClasspath") {
    group = "verification"
    description = "Export actual SDK compile/runtime artifacts for native dependency inspection."
    doLast {
        val artifacts = listOf("debugCompileClasspath", "debugRuntimeClasspath").associateWith { name ->
            configurations.getByName(name).resolvedConfiguration.resolvedArtifacts
                .sortedBy { it.file.absolutePath }
                .map { artifact ->
                    mapOf(
                        "path" to artifact.file.absolutePath,
                        "extension" to artifact.extension,
                        "group" to artifact.moduleVersion.id.group,
                        "name" to artifact.name,
                        "version" to artifact.moduleVersion.id.version,
                    )
                }
        }
        val output = layout.buildDirectory.file("dependency-classpaths.json").get().asFile
        output.parentFile.mkdirs()
        output.writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(artifacts)) + "\n")
    }
}
