# Ulemi for iPhone and iPad

A SwiftUI app that opens the complete Ulemi workspace in WKWebView. It uses the same server, applications and accounts as the web app. Ulemi is the product name; the existing LiveUI project, bundle identifier, service URLs and storage keys remain unchanged. The deployment target is iOS 16.0. The cloud workspace uses WKWebView; offline model inference uses the official Google LiteRT-LM Swift package, which Xcode resolves automatically.

Open `LiveUI.xcodeproj` in a full Xcode installation, select the **LiveUI** scheme, then select an iPhone or iPad simulator. For a physical device, select your Apple signing team in Signing & Capabilities and use an available bundle identifier. The supplied identifier is `com.stonezhang.liveui`; no developer team or signing credentials are included.

```sh
xcodebuild -project LiveUI.xcodeproj -scheme LiveUI \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build

# Replace the simulator name with one listed by xcrun simctl list devices available.
xcodebuild -project LiveUI.xcodeproj -scheme LiveUI \
  -destination 'platform=iOS Simulator,name=iPhone 16' test

# Requires your signing identity, team and provisioning profile.
xcodebuild -project LiveUI.xcodeproj -scheme LiveUI \
  -destination 'generic/platform=iOS' -configuration Release \
  -archivePath build/LiveUI.xcarchive DEVELOPMENT_TEAM=YOUR_TEAM archive
```

The archive can be exported through Xcode Organizer for the chosen development, ad hoc or App Store distribution method. Store submission and distribution signing have not been performed.

## First use

Version 0.2.0 opens with the black U mark, then a native account-and-password login. The brief reveal can be tapped to continue and has no delay when Reduce Motion is enabled. The app uses a fixed application address; no server address or connection settings appear in the user flow. People without an account can open the existing waitlist in their browser.

After verified login, three short, skippable pages introduce describing a need, refining an application and reopening saved work. Completion stays on the device, so returning users go straight to their applications. The account menu can replay the guide, reload, cancel downloads or sign out. Loading and network failures use native screens with a clear retry action; incorrect credentials remain on the login screen. Cancelling login invalidates its pending result, and a saved session is verified by WebKit before it can display first-use guidance.

## Authentication

The fixed address is `https://liveui.stonezhang.com/liveui/`. The Basic authentication realm is fixed to the service’s `LiveUIAgent` realm. A previously saved custom address is discarded rather than moving its credentials to another server.

Only HTTPS addresses without embedded credentials, query strings or fragments are accepted. Login first uses an ephemeral URLSession. It follows only same-origin redirects, requires a successful HTML response after an accepted Basic challenge, and writes the connection to Keychain only after that succeeds. WKWebView and downloads then answer only the exact HTTPS scheme, host, port, Basic realm and first challenge. TLS trust uses system verification; there is no ATS exception or credential-injected JavaScript.

The password is stored using `WhenUnlockedThisDeviceOnly`. Web cookies and application-local storage persist in WebKit until logout. Credentials use no URLCredential persistence. Each WebView gets a fresh WKProcessPool. Logout cancels downloads, deletes the saved connection, clears the app’s shared credential storage and removes WebKit website data. The account menu provides sign-out confirmation without displaying the backend address. No passwords are printed or added to URLs.

## Mobile integration

SwiftUI respects device safe areas and keyboard resizing. The native Back button first closes the visible Ulemi application window, otherwise navigates web history. WebKit provides the standard HTML file/photo picker, media capture prompts, JavaScript dialogs and WebGL support. User-activated external links open outside the app. Same-origin new windows open in the current view. Native WKDownload receives ordinary downloads and `download` links, including blob/data links where supported by WebKit, then presents the iOS share sheet for Save to Files or sharing. Download destinations use fresh private temporary directories and sanitized filenames. Downloads with a declared size above 32 MiB are rejected. Downloads of unknown size remain cancellable from the menu. Failed downloads report failure. Blob downloads from sandboxed iframes and photo/camera picking still require device verification.

The app does not resubmit model or business requests after a network error. Reload is explicit. Background suspension is controlled by iOS; server tasks may continue while the app is suspended.

The privacy manifest declares account identifiers and user-provided photos, audio and other content used by the connected service for app functionality, with no tracking. The native shell has no analytics SDK. The local onboarding preference uses UserDefaults with the CA92.1 privacy-manifest reason. Review the service’s actual handling and App Store privacy answers before distribution.

## Checks

The portable Foundation policy check compiles and runs without an iOS SDK:

```sh
swiftc LiveUI/ConnectionPolicy.swift LiveUITests/PolicyCheck.swift -o /tmp/liveui-policy-check
/tmp/liveui-policy-check
```

The project includes eight XCTest cases covering HTTPS URL validation, exact credential scope, first-use and returning-user policy, Reduce Motion, login cancellation, saved endpoint migration and friendly failure messages. The standalone Foundation check covers 31 assertions. The [Mobile apps workflow](https://github.com/tongmd/liveuiagent/actions/workflows/mobile.yml) builds, runs XCTest, and captures an iPhone simulator login screen. Read the run for the current commit for build and test status; historical runs do not validate later changes. A simulator build uses an ad hoc linker signature, not an Apple distribution identity. The device app still requires your signing identity and provisioning profile before installation. Physical-device login, upload/download, keyboard and 3D behavior have not been verified.

Before distribution, rerun the XCTest suite for your release, then verify real login and wrong-password rejection, safe areas and keyboard, all six harness choices, 3D gestures, HTML/rich applications, development progress and refresh, file/photo selection, ordinary and iframe blob downloads, external links, and logout followed by a different account.


## On-device models

The login screen and account menu both open **本机对话** without requiring a server login. Choose Gemma 4 E4B for quality or E2B for lower memory use, download directly on the phone, and use text chat offline. This local conversation is separate from cloud application generation and does not claim access to cloud applications or online tools.

The downloader uses Google-documented `litert-community` Hugging Face releases. Revisions, exact lengths and SHA-256 hashes are pinned in `LocalModel.swift`. Downloads are streamed to a temporary file, checked in 1 MiB chunks and installed only after the whole-file checksum matches. Pausing saves URLSession resume data; retry can resume after reopening. Wi-Fi is the default, cellular download is opt-in. Model files and local chat are excluded from device backup; deleting a model retains the chat. Model selection and chat remain on the device.

E2B is recommended below 11 GiB physical memory; E4B remains selectable from 7 GiB. E2B needs at least 4 GiB. These are conservative application policies, not a claim of universal model superiority or an iPhone 16 benchmark. Metal is tried first, with an explicit local CPU fallback if initialization fails. The bounded 4096-token context and 512-token reply limit reduce memory use. A phone may still reject loading when memory is occupied. There is no silent cloud fallback. Download needs the model size plus 1 GiB of free storage.

SwiftPM pins the official repository to `3c0b6da5a468f070f6cee9598810ff4438bd3dae`. Its iOS binary is `v0.19.0/CLiteRTLM.xcframework.zip`, SHA-256 `b7b2450fc084058adc5185498f8b7810a9297e054a10cf55818b62e1d5f8d65d`. The package supports iOS 15+, while this app keeps iOS 16+. Xcode resolves and verifies the binary automatically. Set `GIT_LFS_SKIP_SMUDGE=1` while resolving the package to avoid downloading unrelated upstream Linux/Android LFS assets.

Sources: [Google Swift guide](https://developers.google.com/edge/litert-lm/swift), [Gemma 4 models and device measurements](https://developers.google.com/edge/litert-lm/models/gemma-4). Google's published iOS measurements use iPhone 17 Pro. Actual iPhone 16 inference, download interruption and thermal/memory behavior require a physical-device test; simulator compilation alone does not validate those behaviors.
