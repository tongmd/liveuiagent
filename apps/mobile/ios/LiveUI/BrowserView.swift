import SwiftUI
import WebKit
import AVFoundation

@MainActor
struct BrowserView: UIViewRepresentable {
    let connection: Connection
    @ObservedObject var model: BrowserModel
    func makeCoordinator() -> Coordinator { Coordinator(connection: connection, model: model) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.processPool = WKProcessPool()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "UlemiMobile/1"
        config.userContentController.addUserScript(WKUserScript(source: "document.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.ulemiShell='true'})", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.mediaTypesRequiringUserActionForPlayback = [.audio]
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.98, green: 0.98, blue: 0.97, alpha: 1)
        model.webView = webView
        context.coordinator.activeWebView = webView
        if let url = connection.url { webView.load(URLRequest(url: url)) }
        return webView
    }
    func updateUIView(_ webView: WKWebView, context: Context) {}
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        let connection: Connection
        let model: BrowserModel
        weak var activeWebView: WKWebView?
        private var navigationTicket = 0
        init(connection: Connection, model: BrowserModel) { self.connection = connection; self.model = model }
        private func authenticate(_ challenge: URLAuthenticationChallenge,
                                  _ completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                completion(.performDefaultHandling, nil)
            } else if connection.accepts(challenge) && model.connection == connection && model.webView === activeWebView {
                completion(.useCredential, connection.credential)
            } else {
                completion(.cancelAuthenticationChallenge, nil)
                let space = challenge.protectionSpace
                if challenge.previousFailureCount > 0, connection.accepts(host: space.host, port: space.port,
                    protocolName: space.protocol, realm: space.realm, method: space.authenticationMethod, failures: 0),
                   model.connection == connection, model.webView === activeWebView {
                    model.disconnect(message: "登录已失效，请重新登录。")
                }
            }
        }
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            authenticate(challenge, completionHandler)
        }
        func download(_ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
                      completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            authenticate(challenge, completionHandler)
        }
        private func isLocalDocument(_ url: URL) -> Bool {
            if connection.contains(url) { return true }
            if ["about:blank", "about:srcdoc"].contains(url.absoluteString) { return true }
            if url.scheme == "blob", let origin = URL(string: String(url.absoluteString.dropFirst(5))) {
                return connection.contains(origin)
            }
            return false
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.user == nil, url.password == nil else { decisionHandler(.cancel); return }
            if isLocalDocument(url) || (action.shouldPerformDownload && ["blob", "data"].contains(url.scheme ?? "")) {
                decisionHandler(action.shouldPerformDownload ? .download : .allow)
                return
            }
            // External subframes may load HTTPS resources, but never receive our credentials.
            if action.targetFrame?.isMainFrame == false && url.scheme == "https" {
                decisionHandler(.allow); return
            }
            decisionHandler(.cancel)
            if action.navigationType == .linkActivated, ["https", "http", "mailto", "tel"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            } else { model.message = "无法打开这个页面，请返回后重试。" }
        }
        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
                decisionHandler(.cancel)
                guard model.connection == connection, model.webView === webView else { return }
                if http.statusCode == 401 || http.statusCode == 403 {
                    model.disconnect(message: "登录已失效，请重新登录。")
                } else {
                    model.loading = false
                    model.workspaceError = "暂时无法打开你的应用，请稍后重试。"
                }
                return
            }
            let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
            decisionHandler(!response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") ? .download : .allow)
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            guard model.connection == connection, model.webView === webView else { return }
            navigationTicket += 1
            model.loading = true; model.workspaceError = nil; model.workspaceReady = false
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard model.connection == connection, model.webView === webView else { return }
            model.canGoBack = webView.canGoBack
            awaitWorkspace(webView, ticket: navigationTicket, attempt: 0)
        }
        private func awaitWorkspace(_ webView: WKWebView, ticket: Int, attempt: Int) {
            guard model.connection == connection, model.webView === webView,
                  ticket == navigationTicket, model.workspaceError == nil else { return }
            webView.evaluateJavaScript("({ready:[...document.querySelectorAll('textarea')].some(e=>e.getClientRects().length),menu:[...document.querySelectorAll('[data-ulemi-native-menu=\"true\"]')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).pointerEvents!=='none')})") { [weak self, weak webView] result, _ in
                guard let self, let webView, self.model.connection == self.connection,
                      self.model.webView === webView, ticket == self.navigationTicket,
                      self.model.workspaceError == nil else { return }
                if let state = result as? [String: Bool], state["ready"] == true {
                    self.model.hasNativeMenu = state["menu"] == true
                    self.model.loading = false; self.model.workspaceReady = true; self.model.authenticated = true
                } else if attempt >= 60 {
                    self.model.loading = false; self.model.workspaceError = "打开时间有点长，请重试。"
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak webView] in
                        if let webView { self?.awaitWorkspace(webView, ticket: ticket, attempt: attempt + 1) }
                    }
                }
            }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error, webView) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error, webView) }
        private func failed(_ error: Error, _ webView: WKWebView) {
            guard model.connection == connection, model.webView === webView, (error as NSError).code != NSURLErrorCancelled else { return }
            model.loading = false
            model.workspaceError = "网络连接中断，请检查网络后重试。"
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard model.connection == connection, model.webView === webView else { return }
            model.loading = false; model.workspaceError = "页面暂时无法继续，请重新载入。"
        }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self; model.activeDownloads[ObjectIdentifier(download)] = download }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self; model.activeDownloads[ObjectIdentifier(download)] = download }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                      completionHandler: @escaping (URL?) -> Void) {
            guard response.expectedContentLength <= 32 * 1024 * 1024 else {
                model.activeDownloads.removeValue(forKey: ObjectIdentifier(download))
                model.message = "文件超过 32 MB，请在浏览器中下载。"
                completionHandler(nil)
                return
            }
            do {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent("LiveUI-Downloads", isDirectory: true)
                let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let name = (suggestedFilename as NSString).lastPathComponent
                let target = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "download" : name)
                model.downloads[ObjectIdentifier(download)] = target
                completionHandler(target)
            } catch { model.message = "无法保存文件。"; completionHandler(nil) }
        }
        func downloadDidFinish(_ download: WKDownload) {
            model.activeDownloads.removeValue(forKey: ObjectIdentifier(download))
            guard model.connection == connection else { return }
            if let url = model.downloads.removeValue(forKey: ObjectIdentifier(download)) { model.share = .init(url: url) }
        }
        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            model.activeDownloads.removeValue(forKey: ObjectIdentifier(download))
            guard model.connection == connection else { return }
            if let url = model.downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            model.message = "下载未完成，请重试。"
        }
        func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                      decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
            decisionHandler(request.url.map(connection.contains) == true ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let target = navigationAction.request.url, target.user == nil, target.password == nil else { return nil }
            if let url = navigationAction.request.url, isLocalDocument(url) { webView.load(navigationAction.request) }
            else if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            return nil
        }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            func isCurrent() -> Bool {
                MediaPermissionPolicy.allows(connection: connection, originScheme: origin.protocol,
                    originHost: origin.host, originPort: origin.port, frameURL: frame.request.url,
                    authenticated: model.authenticated,
                    current: model.connection == connection && model.webView === webView
                        && webView.url.map(connection.contains) == true)
            }
            guard isCurrent() else {
                if model.connection == connection, model.webView === webView {
                    model.message = "Camera and microphone require the signed-in workspace. External or isolated pages cannot use its permissions."
                }
                decisionHandler(.deny); return
            }
            let ticket = navigationTicket
            Task { @MainActor in
                var granted: Bool
                switch type {
                case .camera: granted = await MediaAccess.request(.video)
                case .microphone: granted = await MediaAccess.request(.audio)
                case .cameraAndMicrophone:
                    let camera = await MediaAccess.request(.video)
                    let microphone = camera ? await MediaAccess.request(.audio) : false
                    granted = camera && microphone
                @unknown default: granted = false
                }
                // Permission may return after logout or navigation. Never grant to
                // a replacement document or resurrect a disconnected session.
                guard isCurrent(), ticket == navigationTicket else { decisionHandler(.deny); return }
                if granted {
                    // iOS authorization is already explicit. This fixed, current
                    // signed-in origin can now capture without a second site popup.
                    decisionHandler(.grant)
                } else {
                    model.mediaPermissionIssue = .init(message: "Camera or microphone access is off. Allow the requested access in Settings, then try the action again.")
                    decisionHandler(.deny)
                }
            }
        }
        private func present(_ controller: UIAlertController, fallback: () -> Void) {
            guard let root = model.webView?.window?.rootViewController else { fallback(); return }
            var presenter = root
            while let next = presenter.presentedViewController { presenter = next }
            presenter.present(controller, animated: true)
        }
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: "Ulemi", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
            present(alert, fallback: completionHandler)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: "Ulemi", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
            present(alert) { completionHandler(false) }
        }
        func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
            if prompt == "__ulemi_menu_v1__" {
                if frame.isMainFrame, let url = frame.request.url, connection.contains(url),
                   model.connection == connection, model.webView === webView {
                    model.showNativeMenu = true
                }
                completionHandler(nil); return
            }
            let alert = UIAlertController(title: "Ulemi", message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
            present(alert) { completionHandler(nil) }
        }
    }
}
