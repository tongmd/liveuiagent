import SwiftUI
import WebKit

@main
@MainActor
struct LiveUIApp: App {
    @StateObject private var browser = BrowserModel()
    var body: some Scene { WindowGroup { RootView().environmentObject(browser).preferredColorScheme(.light) } }
}

@MainActor
final class BrowserModel: ObservableObject {
    @Published var connection = CredentialStore.loadForApp()
    @Published var message: String?
    @Published var imageTools = false
    @Published var mediaPermissionIssue: MediaPermissionIssue?
    @Published var loading = true
    @Published var workspaceReady = false
    @Published var hasNativeMenu = false
    @Published var showNativeMenu = false
    @Published var authenticated = false
    @Published var workspaceError: String?
    @Published var canGoBack = false
    @Published var share: SharedFile?
    @Published var clearing = false
    weak var webView: WKWebView?
    var downloads: [ObjectIdentifier: URL] = [:]
    @Published var activeDownloads: [ObjectIdentifier: WKDownload] = [:]
    struct SharedFile: Identifiable { let id = UUID(); let url: URL }

    func goBack() {
        guard let webView else { return }
        let closeApp = """
        (() => {
            const buttons = [...document.querySelectorAll('.app-sheet button.sheet-close')];
            const button = buttons.reverse().find(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
            if (!button) return false;
            button.click(); return true;
        })()
        """
        webView.evaluateJavaScript(closeApp) { result, _ in
            if result as? Bool != true, webView.canGoBack { webView.goBack() }
        }
    }
    func reload() {
        workspaceError = nil
        loading = true
        if let url = connection?.url { webView?.load(URLRequest(url: url)) }
    }
    func cancelDownloads() {
        activeDownloads.values.forEach { $0.cancel { _ in } }
        activeDownloads.removeAll()
        downloads.removeAll()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("LiveUI-Downloads"))
    }
    func disconnect(message: String? = nil) {
        clearing = true
        webView?.stopLoading()
        cancelDownloads()
        share = nil
        mediaPermissionIssue = nil
        connection = nil
        authenticated = false
        webView = nil
        workspaceReady = false
        hasNativeMenu = false
        showNativeMenu = false
        workspaceError = nil
        loading = true
        self.message = message
        CredentialStore.remove()
        URLCredentialStorage.shared.allCredentials.forEach { space, credentials in
            credentials.values.forEach { URLCredentialStorage.shared.remove($0, for: space) }
        }
        WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
                                                modifiedSince: .distantPast) { [weak self] in
            DispatchQueue.main.async { self?.clearing = false }
        }
    }
    func accept(_ candidate: Connection) throws {
        guard candidate.isAppConnection else { throw LoginVerifier.LoginError.invalidAddress }
        try CredentialStore.save(candidate)
        workspaceReady = false
        hasNativeMenu = false
        showNativeMenu = false
        workspaceError = nil
        loading = true
        connection = candidate
        authenticated = true
        message = nil
    }
}

enum AppStyle {
    static let background = Color(red: 0.98, green: 0.98, blue: 0.975)
    static let ink = Color(red: 0.08, green: 0.08, blue: 0.08)
}

struct BrandMark: View {
    var size: CGFloat = 64
    var body: some View {
        Image("BrandMark").resizable().scaledToFit().frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// The clock stops when hidden or backgrounded. Motion never represents completion.
struct BrandMotion: View {
    var size: CGFloat = 112
    var active = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    @State private var visible = false
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || phase != .active || !visible || !active)) { context in
            let time = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
            let breath = reduceMotion ? 1 : 1 + 0.035 * sin(time * .pi / 1.8)
            ZStack {
                Circle().stroke(AppStyle.ink.opacity(0.055), lineWidth: 1)
                if !reduceMotion {
                    Circle().trim(from: 0.03, to: 0.19)
                        .stroke(AppStyle.ink.opacity(0.24), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                        .rotationEffect(.degrees(time.truncatingRemainder(dividingBy: 6) * 60))
                    Circle().fill(AppStyle.ink.opacity(0.3)).frame(width: 4, height: 4)
                        .offset(y: -size / 2)
                        .rotationEffect(.degrees(-time.truncatingRemainder(dividingBy: 9) * 40))
                }
                BrandMark(size: size * 0.52).scaleEffect(CGFloat(breath))
            }.frame(width: size, height: size)
        }.accessibilityHidden(true)
            .onAppear { visible = true }.onDisappear { visible = false }
    }
}

struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 16, weight: .medium))
            .frame(maxWidth: .infinity).padding(.vertical, 16)
            .foregroundStyle(AppStyle.ink.opacity(enabled ? 0.8 : 0.35))
            .background(.white.opacity(configuration.isPressed ? 0.6 : 1))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(AppStyle.ink.opacity(0.06), lineWidth: 1))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 17)
            .foregroundStyle(.white).background(AppStyle.ink.opacity(enabled ? 1 : 0.35))
            .clipShape(RoundedRectangle(cornerRadius: 18))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

@MainActor
struct RootView: View {
    @EnvironmentObject private var browser: BrowserModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage("liveui.onboarding.completed.v1") private var completedGuide = false
    @State private var starting = true
    @State private var revealed = false
    @State private var showGuide = false
    @State private var confirmLogout = false
    @State private var localChat = false
    @State private var devices = false

    var body: some View {
        ZStack {
            AppStyle.background.ignoresSafeArea()
            NavigationStack {
                Group {
                    if browser.clearing {
                        VStack(spacing: 28) { BrandMotion(); Text("Signing out…").font(.callout).foregroundStyle(.secondary) }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let connection = browser.connection {
                        workspace(connection)
                    } else { ConnectionView() }
                }
                .background(AppStyle.background)
                .navigationTitle(browser.connection == nil ? "" : "Ulemi")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(browser.connection == nil || !browser.workspaceReady || browser.workspaceError != nil || browser.hasNativeMenu ? .hidden : .visible, for: .navigationBar)
                .toolbar {
                    if browser.connection != nil {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Button { browser.goBack() } label: { Image(systemName: "chevron.left") }
                                .accessibilityLabel("Back")
                        }
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Menu {
                                Text(browser.connection?.username ?? "")
                                Button { devices = true } label: { Label("Devices & sensors", systemImage: "sensor") }
                                Button { browser.imageTools = true } label: { Label("View images", systemImage: "photo") }
                                Button("Permissions") { MediaAccess.openSettings() }
                                Button { localChat = true } label: { Label("On-device chat", systemImage: "iphone") }
                                Button { showGuide = true } label: { Label("Quick tour", systemImage: "sparkles") }
                                Button { browser.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                                if !browser.activeDownloads.isEmpty {
                                    Button("Cancel download", role: .destructive) { browser.cancelDownloads() }
                                }
                                Button(role: .destructive) { confirmLogout = true } label: {
                                    Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                                }
                            } label: { Image(systemName: "person.crop.circle") }
                            .accessibilityLabel("Account")
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if browser.connection != nil, let message = browser.message {
                        HStack {
                            Text(message).font(.callout)
                            Spacer()
                            Button("Dismiss") { browser.message = nil }.frame(minWidth: 44, minHeight: 44)
                        }.padding(.horizontal, 16).background(.regularMaterial)
                    }
                }
            }
            .opacity(starting ? 0 : 1)
            .accessibilityHidden(starting)
            if starting {
                VStack(spacing: 20) {
                    BrandMotion(size: 132)
                    Text("Ulemi").font(.system(size: 25, weight: .semibold, design: .rounded)).tracking(-0.7)
                }
                .scaleEffect(revealed || reduceMotion ? 1 : 0.94)
                .opacity(revealed || reduceMotion ? 1 : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AppStyle.background)
                .accessibilityElement(children: .combine)
                .transition(.opacity)
                .onTapGesture { finishLaunch() }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Tap to continue")
            }
        }
        .tint(AppStyle.ink)
        .sheet(isPresented: $localChat) { LocalChatView() }
        .fullScreenCover(isPresented: $browser.imageTools) { ImageToolsView() }
        .alert(item: $browser.mediaPermissionIssue) { issue in
            Alert(title: Text("Media access"), message: Text(issue.message),
                  primaryButton: .default(Text("Open Settings"), action: MediaAccess.openSettings),
                  secondaryButton: .cancel(Text("Not now")))
        }
        .sheet(isPresented: $devices) { DeviceAccessView(workspaceSink: browser.deviceWorkspaceSink()) }
        .sheet(item: $browser.share) { item in ShareSheet(url: item.url) }
        .fullScreenCover(isPresented: $showGuide) {
            OnboardingView {
                completedGuide = true
                showGuide = false
            }
        }
        .confirmationDialog("Ulemi", isPresented: $browser.showNativeMenu, titleVisibility: .visible) {
            Button("Devices & sensors") { devices = true }
            Button("View images") { browser.imageTools = true }
            Button("Permissions") { MediaAccess.openSettings() }
            Button("Back") { browser.goBack() }
            Button("On-device chat") { localChat = true }
            Button("Quick tour") { showGuide = true }
            Button("Reload") { browser.reload() }
            if !browser.activeDownloads.isEmpty { Button("Cancel download", role: .destructive) { browser.cancelDownloads() } }
            Button("Sign out", role: .destructive) { confirmLogout = true }
            Button("Cancel", role: .cancel) { }
        }
        .confirmationDialog("Sign out?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { browser.disconnect() }
        } message: { Text("Your apps are saved. Sign in again to pick up where you left off.") }
        .onChange(of: browser.connection) { connection in
            if connection == nil { showGuide = false; devices = false }
            else if !starting && OnboardingPolicy.shouldPresent(signedIn: browser.authenticated, completed: completedGuide) { showGuide = true }
        }
        .onChange(of: browser.authenticated) { signedIn in
            if !starting && OnboardingPolicy.shouldPresent(signedIn: signedIn, completed: completedGuide) { showGuide = true }
        }
        .task {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.36)) { revealed = true }
            try? await Task.sleep(nanoseconds: OnboardingPolicy.launchDelay(reduceMotion: reduceMotion))
            guard !Task.isCancelled else { return }
            finishLaunch()
        }
    }

    private func finishLaunch() {
        guard starting else { return }
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.22)) { starting = false }
        showGuide = OnboardingPolicy.shouldPresent(signedIn: browser.authenticated, completed: completedGuide)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--preview-local-assistant") {
            showGuide = false
            localChat = true
        }
        if ProcessInfo.processInfo.arguments.contains("--preview-devices") {
            showGuide = false
            localChat = false
            devices = true
        }
        #endif
    }

    private func workspace(_ connection: Connection) -> some View {
        ZStack {
            BrowserView(connection: connection, model: browser).id(connection.address + connection.username)
                .opacity(browser.workspaceReady && browser.workspaceError == nil ? 1 : 0)
                .accessibilityHidden(!browser.workspaceReady || browser.workspaceError != nil)
            if !browser.workspaceReady || browser.workspaceError != nil {
                VStack(spacing: 28) {
                    if let error = browser.workspaceError {
                        BrandMark(size: 58)
                        Text(error).font(.body).multilineTextAlignment(.center)
                        Button("Try again") { browser.reload() }.buttonStyle(PrimaryButtonStyle())
                        Button("Back to sign in") { browser.disconnect() }.buttonStyle(SecondaryButtonStyle())
                    } else {
                        VStack(spacing: 16) {
                            BrandMotion(size: 90, active: !showGuide && !localChat)
                            Text("Opening workspace")
                                .font(.system(size: 13, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                }.padding(28).frame(maxWidth: 360)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(AppStyle.background)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: browser.workspaceReady)
    }
}

@MainActor
struct ConnectionView: View {
    @EnvironmentObject private var browser: BrowserModel
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var loginTask: Task<Void, Never>?
    @State private var attempt = LoginAttempt()
    @State private var localChat = false
    @State private var devices = false
    @FocusState private var focusedField: Field?
    private enum Field { case username, password }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 13) { BrandMark(size: 37); Text("Ulemi").font(.system(size: 21, weight: .semibold, design: .rounded)).tracking(-0.5) }.padding(.bottom, 28)
                    Text("Make it yours.").font(.system(size: 38, weight: .semibold)).tracking(-1.5)
                    Text("Turn an idea into something you can use.")
                        .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.bottom, 8)
                VStack(alignment: .leading, spacing: 14) {
                    TextField("Username", text: $username).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .username).submitLabel(.next)
                        .onSubmit { focusedField = .password }
                        .accessibilityIdentifier("login-account")
                        .padding(18).background(.white, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(AppStyle.ink.opacity(0.07), lineWidth: 1))
                    SecureField("Password", text: $password).textContentType(.password)
                        .focused($focusedField, equals: .password).submitLabel(.go)
                        .onSubmit { signIn() }
                        .accessibilityIdentifier("login-password")
                        .padding(18).background(.white, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(AppStyle.ink.opacity(0.07), lineWidth: 1))
                    if let message = error ?? browser.message {
                        Text(message).font(.callout).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("login-error")
                    }
                }.disabled(busy)
                VStack(spacing: 12) {
                    Button { signIn() } label: {
                        HStack(spacing: 10) {
                            if busy { ProgressView().tint(.white) }
                            Text(busy ? "Signing in…" : "Sign in")
                        }
                    }.buttonStyle(PrimaryButtonStyle())
                        .disabled(busy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                        .accessibilityIdentifier("login-submit")
                    Button("Devices & sensors") { devices = true }.frame(minHeight: 44)
                    Button("View images") { browser.imageTools = true }.frame(minHeight: 44)
                    Button("Continue on this device") { localChat = true }.buttonStyle(SecondaryButtonStyle())
                    if busy { Button("Cancel") { cancelLogin() }.frame(minHeight: 44) }
                    else {
                        Link("Join the waitlist", destination: URL(string: "https://docs.google.com/forms/d/e/1FAIpQLSckrULbwm5t1j0UiV7KwVIUwq2-qsMnI4pkikL7Ii1J6K55QA/viewform")!)
                            .font(.callout).frame(minHeight: 44)
                    }
                }
            }.padding(.horizontal, 28).padding(.top, 48).padding(.bottom, 28)
                .frame(maxWidth: 440).frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AppStyle.background)
        .sheet(isPresented: $localChat) { LocalChatView() }
        .sheet(isPresented: $devices) { DeviceAccessView() }
        .onDisappear { cancelLogin() }
    }

    private func cancelLogin() {
        attempt.cancel()
        loginTask?.cancel()
        loginTask = nil
        busy = false
    }
    private func signIn() {
        guard !busy, !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !password.isEmpty else { return }
        focusedField = nil
        busy = true; error = nil; browser.message = nil
        let ticket = attempt.begin()
        let candidate = Connection(address: Connection.defaultAddress,
                                   username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                                   password: password, realm: "LiveUIAgent")
        loginTask = Task {
            do {
                try await LoginVerifier(connection: candidate).verify()
                try Task.checkCancellation()
                guard attempt.isCurrent(ticket) else { return }
                try browser.accept(candidate)
                password = ""
            } catch {
                guard !Task.isCancelled, attempt.isCurrent(ticket) else { return }
                if error is CredentialStore.StoreError {
                    self.error = "Your sign-in could not be saved securely. Unlock your device and try again."
                } else { self.error = LoginFeedback.message(for: error) }
            }
            guard attempt.isCurrent(ticket) else { return }
            busy = false
            loginTask = nil
        }
    }
}

private struct GuideIllustration: View {
    let page: Int
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var phase
    @State private var visible = false
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion || phase != .active || !visible || !active)) { context in
            let wave = reduceMotion ? 0 : sin(context.date.timeIntervalSinceReferenceDate * 1.5)
            ZStack {
                RoundedRectangle(cornerRadius: 28).fill(.white)
                    .frame(width: 220, height: 150).rotationEffect(.degrees(-5))
                    .offset(x: -10, y: 6)
                    .overlay(RoundedRectangle(cornerRadius: 28).stroke(AppStyle.ink.opacity(0.05), lineWidth: 1).frame(width: 220, height: 150).rotationEffect(.degrees(-5)).offset(x: -10, y: 6))
                VStack(alignment: .leading, spacing: 16) {
                    HStack { BrandMark(size: 23); Spacer(); Circle().fill(AppStyle.ink.opacity(0.1)).frame(width: 5, height: 5) }
                    if page == 0 {
                        Capsule().fill(AppStyle.ink.opacity(0.12)).frame(width: 126, height: 8)
                        Capsule().fill(AppStyle.ink.opacity(0.06)).frame(width: 86, height: 8)
                    } else if page == 1 {
                        HStack(alignment: .bottom, spacing: 8) {
                            ForEach(0..<4) { i in RoundedRectangle(cornerRadius: 5).fill(AppStyle.ink.opacity(0.12 + Double(i) * 0.12)).frame(width: 28, height: CGFloat(20 + i * 8) + CGFloat(wave) * 3) }
                        }.frame(height: 46)
                    } else {
                        HStack(spacing: 10) { ForEach(0..<3) { _ in RoundedRectangle(cornerRadius: 10).fill(AppStyle.ink.opacity(0.08)).frame(width: 44, height: 42) } }
                    }
                }.padding(24).frame(width: 220, height: 150).background(AppStyle.background, in: RoundedRectangle(cornerRadius: 24))
                    .overlay(RoundedRectangle(cornerRadius: 24).stroke(AppStyle.ink.opacity(0.10), lineWidth: 1))
                    .offset(x: 6, y: -5 + CGFloat(wave) * 3)
            }.frame(maxWidth: .infinity).accessibilityHidden(true)
        }.onAppear { visible = true }.onDisappear { visible = false }
    }
}

@MainActor
struct OnboardingView: View {
    let finish: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    private let pages: [(icon: String, title: String, body: String)] = [
        ("text.bubble", "Start with an idea.", "Describe what you need. Plan a trip, organize your day, or explore your data."),
        ("slider.horizontal.3", "Shape it as you go.", "Keep the conversation going. Change the content, tools, and layout as your needs evolve."),
        ("square.grid.2x2", "Pick up where you left off.", "Your apps stay in your workspace. Open one whenever you want to continue.")
    ]
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Ulemi").font(.headline)
                Spacer()
                Button("Skip") { finish() }.frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("guide-skip")
            }.padding(.horizontal, 24)
            TabView(selection: $page) {
                ForEach(pages.indices, id: \.self) { index in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 28) {
                            GuideIllustration(page: index, active: page == index).frame(height: 210)
                            Text(pages[index].title).font(.largeTitle.weight(.semibold))
                            Text(pages[index].body).font(.title3).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }.padding(.horizontal, 28).padding(.top, 40).padding(.bottom, 24)
                            .frame(maxWidth: 440).frame(maxWidth: .infinity)
                    }.tag(index)
                }
            }.tabViewStyle(.page(indexDisplayMode: .never))
            VStack(spacing: 22) {
                HStack(spacing: 8) {
                    ForEach(pages.indices, id: \.self) { index in
                        Capsule().fill(index == page ? AppStyle.ink : Color.gray.opacity(0.25))
                            .frame(width: index == page ? 24 : 7, height: 7)
                    }
                }.accessibilityElement(children: .ignore).accessibilityLabel("Step \(page + 1) of 3")
                    .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: page)
                Button {
                    if page == pages.count - 1 { finish() }
                    else { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { page += 1 } }
                } label: { Text(page == pages.count - 1 ? "Get started" : "Continue") }
                    .buttonStyle(PrimaryButtonStyle()).accessibilityIdentifier("guide-next")
            }.padding(.horizontal, 28).padding(.vertical, 24).frame(maxWidth: 440)
        }
        .background(AppStyle.background).foregroundStyle(AppStyle.ink).tint(AppStyle.ink)
        .interactiveDismissDisabled()
    }
}

@MainActor
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
