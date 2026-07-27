plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "com.cursorremote.dicktator"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.cursorremote.dicktator"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.14"
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  implementation(project(":voice-api"))
  implementation("io.getstream:stream-webrtc-android:1.3.8")
  implementation(platform("androidx.compose:compose-bom:2024.12.01"))
  implementation("androidx.activity:activity-compose:1.10.0")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  debugImplementation("androidx.compose.ui:ui-tooling")
  testImplementation("junit:junit:4.13.2")
}
