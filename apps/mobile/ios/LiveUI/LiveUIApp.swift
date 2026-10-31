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

private enum AppStyle {
    static let background = Color(red: 0.98, green: 0.98, blue: 0.97)
    static let ink = Color(red: 0.08, green: 0.08, blue: 0.08)
}

private struct BrandMark: View {
    var size: CGFloat = 64
    var body: some View {
        Image("BrandMark").resizable().scaledToFit().frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct PrimaryButtonStyle: ButtonStyle {
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
                        ProgressView("正在退出…").frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let connection = browser.connection {
                        workspace(connection)
                    } else { ConnectionView() }
                }
                .background(AppStyle.background)
                .navigationTitle(browser.connection == nil ? "" : "Ulemi")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(browser.connection == nil || (browser.hasNativeMenu && browser.workspaceError == nil) ? .hidden : .visible, for: .navigationBar)
                .toolbar {
                    if browser.connection != nil {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Button { browser.goBack() } label: { Image(systemName: "chevron.left") }
                                .accessibilityLabel("返回")
                        }
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Menu {
                                Text(browser.connection?.username ?? "")
                                Button { localChat = true } label: { Label("本机对话", systemImage: "iphone") }
                                Button { devices = true } label: { Label("Devices & sensors", systemImage: "sensor") }
                                Button { showGuide = true } label: { Label("使用指引", systemImage: "sparkles") }
                                Button { browser.reload() } label: { Label("重新载入", systemImage: "arrow.clockwise") }
                                if !browser.activeDownloads.isEmpty {
                                    Button("取消下载", role: .destructive) { browser.cancelDownloads() }
                                }
                                Button(role: .destructive) { confirmLogout = true } label: {
                                    Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                                }
                            } label: { Image(systemName: "person.crop.circle") }
                            .accessibilityLabel("账号")
                        }
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if browser.connection != nil, let message = browser.message {
                        HStack {
                            Text(message).font(.callout)
                            Spacer()
                            Button("关闭") { browser.message = nil }.frame(minWidth: 44, minHeight: 44)
                        }.padding(.horizontal, 16).background(.regularMaterial)
                    }
                }
            }
            .opacity(starting ? 0 : 1)
            .accessibilityHidden(starting)
            if starting {
                VStack(spacing: 20) {
                    BrandMark(size: 82)
                    Text("Ulemi").font(.system(size: 28, weight: .semibold))
                }
                .scaleEffect(revealed || reduceMotion ? 1 : 0.94)
                .opacity(revealed || reduceMotion ? 1 : 0)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(AppStyle.background)
                .accessibilityElement(children: .combine)
                .transition(.opacity)
                .onTapGesture { finishLaunch() }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("轻点继续")
            }
        }
        .tint(AppStyle.ink)
        .sheet(isPresented: $localChat) { LocalChatView() }
        .sheet(isPresented: $devices) { DeviceAccessView(workspaceSink: browser.deviceWorkspaceSink()) }
        .sheet(item: $browser.share) { item in ShareSheet(url: item.url) }
        .fullScreenCover(isPresented: $showGuide) {
            OnboardingView {
                completedGuide = true
                showGuide = false
            }
        }
        .confirmationDialog("Ulemi", isPresented: $browser.showNativeMenu, titleVisibility: .visible) {
            Button("返回") { browser.goBack() }
            Button("本机对话") { localChat = true }
            Button("Devices & sensors") { devices = true }
            Button("使用指引") { showGuide = true }
            Button("重新载入") { browser.reload() }
            if !browser.activeDownloads.isEmpty { Button("取消下载", role: .destructive) { browser.cancelDownloads() } }
            Button("退出登录", role: .destructive) { confirmLogout = true }
            Button("取消", role: .cancel) { }
        }
        .confirmationDialog("退出当前账号？", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("退出登录", role: .destructive) { browser.disconnect() }
        } message: { Text("已保存的应用会保留，下次登录后可以继续使用。") }
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
                VStack(spacing: 24) {
                    BrandMark(size: 58)
                    if let error = browser.workspaceError {
                        Text(error).font(.body).multilineTextAlignment(.center)
                        Button("重试") { browser.reload() }.buttonStyle(PrimaryButtonStyle())
                        Button("返回登录") { browser.disconnect() }.frame(minHeight: 44)
                    } else {
                        ProgressView().tint(AppStyle.ink)
                        Text("正在打开你的应用…").font(.body)
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
                    BrandMark(size: 66)
                    Text("欢迎来到 Ulemi").font(.largeTitle.weight(.semibold))
                    Text("从一个想法开始，做出自己的应用。")
                        .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.bottom, 8)
                VStack(alignment: .leading, spacing: 14) {
                    TextField("账号", text: $username).textContentType(.username)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($focusedField, equals: .username).submitLabel(.next)
                        .onSubmit { focusedField = .password }
                        .accessibilityIdentifier("login-account")
                        .padding(17).background(.white, in: RoundedRectangle(cornerRadius: 16))
                    SecureField("密码", text: $password).textContentType(.password)
                        .focused($focusedField, equals: .password).submitLabel(.go)
                        .onSubmit { signIn() }
                        .accessibilityIdentifier("login-password")
                        .padding(17).background(.white, in: RoundedRectangle(cornerRadius: 16))
                    if let message = error ?? browser.message {
                        Text(message).font(.callout).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("login-error")
                    }
                }.disabled(busy)
                VStack(spacing: 12) {
                    Button { signIn() } label: {
                        HStack(spacing: 10) {
                            if busy { ProgressView().tint(.white) }
                            Text(busy ? "正在登录…" : "登录")
                        }
                    }.buttonStyle(PrimaryButtonStyle())
                        .disabled(busy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                        .accessibilityIdentifier("login-submit")
                    Button("使用手机模型，不登录") { localChat = true }.frame(minHeight: 44)
                    Button("Devices & sensors") { devices = true }.frame(minHeight: 44)
                    if busy { Button("取消") { cancelLogin() }.frame(minHeight: 44) }
                    else {
                        Link("还没有账号？加入候补名单", destination: URL(string: "https://docs.google.com/forms/d/e/1FAIpQLSckrULbwm5t1j0UiV7KwVIUwq2-qsMnI4pkikL7Ii1J6K55QA/viewform")!)
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
                    self.error = "暂时无法安全保存登录信息，请解锁设备后重试。"
                } else { self.error = LoginFeedback.message(for: error) }
            }
            guard attempt.isCurrent(ticket) else { return }
            busy = false
            loginTask = nil
        }
    }
}

@MainActor
struct OnboardingView: View {
    let finish: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page = 0
    private let pages: [(icon: String, title: String, body: String)] = [
        ("text.bubble", "说说你想做什么", "在底部输入你的想法，例如整理待办、规划行程，或比较一组数据。"),
        ("slider.horizontal.3", "边用边调整", "打开应用后，继续告诉 Ulemi 你的想法。你可以调整内容、功能和布局。"),
        ("square.grid.2x2", "随时回来继续", "关闭应用会回到列表。下次打开时，继续使用已保存的内容。")
    ]
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Ulemi").font(.headline)
                Spacer()
                Button("跳过") { finish() }.frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("guide-skip")
            }.padding(.horizontal, 24)
            TabView(selection: $page) {
                ForEach(pages.indices, id: \.self) { index in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 28) {
                            Image(systemName: pages[index].icon).font(.system(size: 70, weight: .light))
                                .accessibilityHidden(true).frame(height: 120)
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
                }.accessibilityElement(children: .ignore).accessibilityLabel("第 \(page + 1) 步，共 3 步")
                Button {
                    if page == pages.count - 1 { finish() }
                    else { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { page += 1 } }
                } label: { Text(page == pages.count - 1 ? "开始使用" : "继续") }
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
