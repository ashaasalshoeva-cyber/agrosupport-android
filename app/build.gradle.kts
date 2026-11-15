plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.agrisupport.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.agrisupport.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 21
        versionName = "0.2.1"
        val apiBase = (project.findProperty("AGRISUPPORT_API_BASE") as String? ?: "").trim().trimEnd('/')
        buildConfigField("String", "API_BASE", "\"$apiBase\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signing: see README (Build > Generate Signed App Bundle / APK).
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
}
