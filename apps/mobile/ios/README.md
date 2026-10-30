# liveUI for iPhone and iPad

A SwiftUI app that opens the complete liveUI service in WKWebView. It uses the same server, applications and accounts as the web app. The deployment target is iOS 16.0. There are no third-party SDKs or package installation steps.

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

## Connection

The default address is `https://liveui.stonezhang.com/liveui/`. Enter the existing username and password. The Basic authentication realm is fixed to the service’s `LiveUIAgent` realm. The address is editable under Server in the login form.

Only HTTPS addresses without embedded credentials, query strings or fragments are accepted. Login first uses an ephemeral URLSession. It follows only same-origin redirects, requires a successful HTML response after an accepted Basic challenge, and writes the connection to Keychain only after that succeeds. WKWebView and downloads then answer only the exact HTTPS scheme, host, port, Basic realm and first challenge. TLS trust uses system verification; there is no ATS exception or credential-injected JavaScript.

The password is stored using `WhenUnlockedThisDeviceOnly`. Web cookies and application-local storage persist in WebKit until logout. Credentials use no URLCredential persistence. Each WebView gets a fresh WKProcessPool. Logout cancels downloads, deletes the saved connection, clears the app’s shared credential storage and removes WebKit website data. Settings shows the current service and account; changing connections signs out first. No passwords are printed or added to URLs.

## Mobile integration

SwiftUI respects device safe areas and keyboard resizing. The native Back button first closes the visible liveUI application window, otherwise navigates web history. WebKit provides the standard HTML file/photo picker, media capture prompts, JavaScript dialogs and WebGL support. User-activated external links open outside the app. Same-origin new windows open in the current view. Native WKDownload receives ordinary downloads and `download` links, including blob/data links where supported by WebKit, then presents the iOS share sheet for Save to Files or sharing. Download destinations use fresh private temporary directories and sanitized filenames. Downloads with a declared size above 32 MiB are rejected. Downloads of unknown size remain cancellable from the menu. Failed downloads report failure. Blob downloads from sandboxed iframes and photo/camera picking still require device verification.

The app does not resubmit model or business requests after a network error. Reload is explicit. Background suspension is controlled by iOS; server tasks may continue while the app is suspended.

The privacy manifest declares account identifiers and user-provided photos, audio and other content used by the connected service for app functionality, with no tracking. The native shell has no analytics SDK. Review the selected server's actual handling and App Store privacy answers before distribution.

## Checks

The portable Foundation policy check compiles and runs without an iOS SDK:

```sh
swiftc LiveUI/ConnectionPolicy.swift LiveUITests/PolicyCheck.swift -o /tmp/liveui-policy-check
/tmp/liveui-policy-check
```

The project includes XCTest cases for HTTPS URL validation and exact credential scope. Local syntax and plist checks do not replace an iOS build or simulator run. This implementation was prepared on a Mac with Command Line Tools only: full Xcode, the iOS SDK and signing identities were unavailable. No iOS binary, IPA, simulator run, physical-device login/upload/download, keyboard or 3D result is claimed as verified.

Before distribution, build and run the XCTest suite, then verify real login and wrong-password rejection, safe areas and keyboard, all six harness choices, 3D gestures, HTML/rich applications, development progress and refresh, file/photo selection, ordinary and iframe blob downloads, external links, and logout followed by a different account.
