# liveUI for Android and iOS

Native installation projects for the current liveUI workspace. Android uses WebView; iOS uses WKWebView. The workspace remains served by your liveUI installation, so applications, model settings, development conversations, and saved data stay on the same server. These apps need an internet connection and a running server.

The mobile projects use the selected black U icon. They do not bundle model credentials or an account password. Enter your HTTPS server address and existing account when connecting. The older `apps/shell` is a separate component-renderer prototype, not the build target for these apps.

## Android

Open `android/` in Android Studio, or use its Gradle wrapper with JDK 17 and Android SDK 35:

```sh
cd apps/mobile/android
./gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/`. A debug APK can be installed directly; a release APK must be signed with your own persistent Android signing key before distribution. Keep that key outside this repository. Future updates must use the same application ID and signing key.

## iPhone and iPad

Open `ios/LiveUI.xcodeproj` in Xcode. Select the liveUI target, choose your Apple development team under Signing & Capabilities, and run on your device. Use Product → Archive for a distribution build. Signing profiles and certificates are not included.

Simulator builds do not require device signing:

```sh
xcodebuild -project ios/LiveUI.xcodeproj -scheme LiveUI \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

The iOS project requires the full Xcode application and its iOS SDK. Command Line Tools alone cannot build an iPhone app. TestFlight and App Store distribution require the appropriate Apple account and provisioning.

## Connection and behavior

- Only HTTPS connections are accepted; system certificate verification remains enabled.
- Account credentials are held in Android Keystore-backed encrypted storage or iOS Keychain, not injected into JavaScript.
- External links leave the app without attaching the liveUI credentials.
- Signing out removes the saved connection and the embedded browser's session data.
- Refreshing reconnects to the server. The mobile app does not automatically replay a submitted model request.

The Android and iOS projects contain their platform-specific verification instructions. A native build or simulated browser check is not a substitute for testing authentication, uploads, downloads, WebGL, and the keyboard on the target device.
