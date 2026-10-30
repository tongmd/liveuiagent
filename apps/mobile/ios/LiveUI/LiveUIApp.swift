import SwiftUI
import WebKit

@main
@MainActor
struct LiveUIApp: App {
    @StateObject private var browser = BrowserModel()
    var body: some Scene { WindowGroup { RootView().environmentObject(browser) } }
}

@MainActor
final class BrowserModel: ObservableObject {
    @Published var connection = CredentialStore.load()
    @Published var message: String?
    @Published var loading = false
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
    func cancelDownloads() {
        activeDownloads.values.forEach { $0.cancel { _ in } }
        activeDownloads.removeAll()
        downloads.removeAll()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("LiveUI-Downloads"))
    }
    func disconnect() {
        clearing = true
        webView?.stopLoading()
        cancelDownloads()
        share = nil
        connection = nil
        webView = nil
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
        try CredentialStore.save(candidate)
        connection = candidate
        message = nil
    }
}

@MainActor
struct RootView: View {
    @State private var showSettings = false
    @EnvironmentObject private var browser: BrowserModel
    var body: some View {
        NavigationStack {
            Group {
                if browser.clearing { ProgressView("正在退出…") }
                else if let connection = browser.connection {
                    BrowserView(connection: connection, model: browser)
                        .id(connection.address + connection.username)
                } else { ConnectionView() }
            }
            .navigationTitle("liveUI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if browser.connection != nil {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { browser.goBack() } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("返回")
                    }
                    ToolbarItemGroup(placement: .navigationBarTrailing) {
                        if browser.loading { ProgressView() }
                        Button { browser.webView?.reload() } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("重新载入")
                        Menu {
                            Text(browser.connection?.url?.host ?? "")
                            if !browser.activeDownloads.isEmpty { Button("取消下载", role: .destructive) { browser.cancelDownloads() } }
                            Button { showSettings = true } label: { Label("连接设置", systemImage: "gearshape") }
                            Button(role: .destructive) { browser.disconnect() } label: { Label("退出", systemImage: "rectangle.portrait.and.arrow.right") }
                        } label: { Image(systemName: "ellipsis.circle") }
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let message = browser.message {
                    HStack { Text(message).font(.footnote); Spacer(); Button("关闭") { browser.message = nil } }
                        .padding(12).background(.regularMaterial)
                }
            }
            .sheet(item: $browser.share) { item in ShareSheet(url: item.url) }
            .sheet(isPresented: $showSettings) {
                NavigationStack {
                    Form {
                        LabeledContent("服务", value: browser.connection?.address ?? "")
                        LabeledContent("账号", value: browser.connection?.username ?? "")
                        Button("退出并更换连接", role: .destructive) { showSettings = false; browser.disconnect() }
                    }.navigationTitle("连接设置")
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showSettings = false } } }
                }
            }
        }
    }
}

@MainActor
struct ConnectionView: View {
    @EnvironmentObject private var browser: BrowserModel
    @State private var address = Connection.defaultAddress
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section {
                TextField("用户名", text: $username).textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("密码", text: $password).textContentType(.password)
                DisclosureGroup("服务器") {
                    TextField("https://…", text: $address).keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            } header: { Text("连接 liveUI") }
            Section {
                Button {
                    busy = true; error = nil
                    let candidate = Connection(address: address.trimmingCharacters(in: .whitespacesAndNewlines),
                                               username: username, password: password, realm: "LiveUIAgent")
                    Task {
                        do {
                            try await LoginVerifier(connection: candidate).verify()
                            try browser.accept(candidate)
                            password = ""
                        } catch { self.error = "未能连接。请检查 HTTPS 地址、账号、密码，然后重试。" }
                        busy = false
                    }
                } label: { HStack { Text("连接"); if busy { Spacer(); ProgressView() } } }
                .disabled(busy || username.isEmpty || password.isEmpty || Connection.validURL(address) == nil)
                if let error { Text(error).foregroundStyle(.red) }
            } footer: { Text("使用现有 liveUI 账号。连接成功后，密码保存在本机钥匙串。") }
        }.disabled(busy)
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
