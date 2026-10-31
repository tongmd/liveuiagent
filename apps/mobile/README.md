# Ulemi for Android and iOS

Ulemi is the mobile app for the existing liveUI workspace. Android uses WebView; iOS uses WKWebView. The workspace remains served by your liveUI installation, so applications, model settings, development conversations, and saved data stay on the same server. The hosted workspace needs an internet connection and a running server. The separate on-device assistant runs locally after its model has been downloaded.

The mobile projects use the selected black U icon. The visible app name is Ulemi; existing package identifiers, credentials, and service addresses stay compatible. They do not bundle model credentials or an account password. Sign in with your existing liveUI account. The service address is built into the app; the first-use flow does not ask for backend configuration. The older `apps/shell` is a separate component-renderer prototype, not the build target for these apps.

## First use

A brief black U animation leads into account sign-in. The first successful login offers three short, skippable steps: describe what you need, refine an application through conversation, and reopen it later. Returning users go straight to their workspace after authentication. The account menu can reopen the guide.

The native interface uses English throughout sign-in, the guide, loading, account menus, and on-device chat controls. A compact animated U connects launch and loading, then fades into the workspace when it is ready. The hosted workspace and user-created content retain their own language.

The interface respects reduced-motion settings and keeps login errors next to the form. Invalid credentials and unavailable connectivity have different recovery messages. Loading and retry screens do not resubmit application requests. Signing out removes local credentials and browser session data, while the account's applications remain on the service.

## On-device assistant

Open the on-device assistant from sign-in or the account menu. No account or API key is needed for local conversation. Android offers Gemma 4 E4B; iOS offers E4B and the smaller E2B with a device-memory recommendation. Choose a model, download it, and the app verifies and configures the local runtime. Downloads can be paused and continued. Models and local conversations stay in private app storage.

The files come from the LiteRT Community repositories linked by [Google’s official Gemma 4 guide](https://developers.google.com/edge/litert-lm/models/gemma-4). Downloads use immutable revisions, expected byte counts and SHA-256 verification before activation. E4B is 3,659,530,240 bytes; E2B is 2,588,147,712 bytes. Leave additional space for runtime caches. An incomplete or corrupt download is never passed to the inference engine.

Inference uses [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), tries GPU acceleration, and reports a CPU fallback when GPU initialization is unavailable. It does not silently send a local prompt to a cloud provider. Device memory, thermal limits and supported drivers affect whether a model can load and how fast it responds. Google’s published iPhone measurements use an iPhone 17 Pro; they do not establish a universal best model or verify every iPhone 16 device.

Local conversation and the hosted application workspace are separate. This version does not run the workspace’s application-generation tools, connected services or development sessions through the local model. Signing out of the hosted workspace does not erase local chat or model files; use the local assistant’s clear/delete controls for those.

## Android

Open `android/` in Android Studio, or use its Gradle wrapper with JDK 21 and Android SDK 35:

```sh
cd apps/mobile/android
./gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/`. Use `-Parm64Only=true` for the smaller ARM64 phone package distributed by CI. The default build retains both supported ABIs; E4B local inference requires ARM64 and an 8 GB-class device. A debug APK can be installed directly; a release APK must be signed with your own persistent Android signing key before distribution. Keep that key outside this repository. Future updates must use the same application ID and signing key.

## iPhone and iPad

Open `ios/LiveUI.xcodeproj` in Xcode. Select the liveUI target, choose your Apple development team under Signing & Capabilities, and run on your device. Use Product → Archive for a distribution build. Signing profiles and certificates are not included.

Simulator builds do not require device signing:

```sh
xcodebuild -project ios/LiveUI.xcodeproj -scheme LiveUI \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
```

The local inference SDK supports ARM64 devices and ARM64 simulators. Simulator tests require an Apple Silicon Mac. The app disables model loading in the simulator; use a physical phone for actual inference.

The iOS project requires the full Xcode application and its iOS SDK. Command Line Tools alone cannot build an iPhone app. TestFlight and App Store distribution require the appropriate Apple account and provisioning.

## Connection and behavior

- Only HTTPS connections are accepted; system certificate verification remains enabled.
- Account credentials are held in Android Keystore-backed encrypted storage or iOS Keychain, not injected into JavaScript.
- External links leave the app without attaching the liveUI credentials.
- Signing out removes the saved connection and the embedded browser's session data.
- Refreshing reconnects to the server. The mobile app does not automatically replay a submitted model request.

The Android and iOS projects contain their platform-specific verification instructions. A native build or simulated browser check is not a substitute for testing authentication, uploads, downloads, WebGL, and the keyboard on the target device.

## Current file support

Android opens the system document picker for file and photo selection. Same-origin HTTPS downloads use a 32 MiB limit; top-level Blob exports use an 8 MiB limit and the system Save dialog. Downloads from an opaque-origin sandboxed HTML iframe may need the system browser. Camera recording, microphone, and location permissions are not enabled in the Android wrapper.

iOS uses WebKit's file picker and download handling, followed by the system share sheet. A download with a known size above 32 MiB is rejected; downloads with an unknown size can be canceled from the menu. These paths still require device testing for the particular generated application. Neither platform changes the server's own upload or request limits.

Run `android/tests/run-policy-tests.sh` for Android URL and authentication-boundary checks. Android's instrumentation APK tests encrypted storage, tamper rejection, and logout in a separate test namespace. The shared iOS scheme includes authentication-boundary XCTest tests. The `Mobile apps` workflow builds both platforms, runs iOS tests, and launches the iOS app in a simulator; its unsigned iPhone build is not a device-installable IPA.

## Android updates

Ulemi checks for a newer Android release on return to the app and through a periodic Android job. It automatically downloads on unmetered connections and verifies the exact size, SHA-256, package, version, and installed signing identity before installation. The Updates menu also supports a manual check. Android controls installation approval; supported systems can install self-updates without another confirmation once installation permission has been granted. Other systems present their installation screen. Updates preserve the application ID, account, offline model files, and local content.

Publish signed releases with the original signing key and a strictly increasing `versionCode`. The updater reads `https://ulemi-updates.pages.dev/android/latest.json`. To stage the public update channel:

```sh
python3 apps/mobile/scripts/prepare-android-update.py signed-release.apk \
  --build-tools "$ANDROID_HOME/build-tools/35.0.0" \
  --output /path/to/update-channel \
  --notes "Release improvements."
wrangler pages deploy /path/to/update-channel --project-name ulemi-updates --branch main --force
```

The staging script verifies the existing release certificate and refuses lower version codes or changed bytes under an already published code. Keep the staging directory across releases to retain immutable APK URLs; it also retrieves the currently advertised prior package when starting a fresh directory. Before deployment, serialize publication and recheck that the production manifest has not advanced. After deployment, fetch the manifest and APK from the public URL and verify their version, size and SHA-256. Never place signing keys or credentials in the public directory.
