import XCTest
import UIKit
import SwiftUI
import WebKit
@testable import LiveUI

final class ImageToolsTests: XCTestCase {
    let connection = Connection(address: "https://workspace.example/liveui/", username: "user", password: "fixture", realm: "LiveUIAgent")

    func testMediaRequiresCurrentAuthenticatedSameOriginFrame() {
        func allows(_ scheme: String = "https", _ host: String = "workspace.example", _ port: Int = 0,
                    _ frame: String = "https://workspace.example/app", _ auth: Bool = true, _ current: Bool = true) -> Bool {
            MediaPermissionPolicy.allows(connection: connection, originScheme: scheme, originHost: host,
                originPort: port, frameURL: URL(string: frame), authenticated: auth, current: current)
        }
        XCTAssertTrue(allows())
        XCTAssertTrue(allows("https", "WORKSPACE.EXAMPLE", 443))
        XCTAssertFalse(allows("http"))
        XCTAssertFalse(allows("https", "external.example"))
        XCTAssertFalse(allows("https", "workspace.example", 8443))
        XCTAssertFalse(allows("https", "workspace.example", 443, "https://external.example/app"))
        XCTAssertFalse(allows("https", "workspace.example", 443, "about:srcdoc"))
        XCTAssertFalse(allows("https", "workspace.example", 443, "https://workspace.example/app", false))
        XCTAssertFalse(allows("https", "workspace.example", 443, "https://workspace.example/app", true, false))
    }

    func testImageDecoderReadsActualImageAndRejectsInvalidFile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("sample.png")
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 120, height: 80), format: format).image { ctx in
            UIColor.orange.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
        }
        try XCTUnwrap(image.pngData()).write(to: url)
        let loaded = try ImagePreviewDecoder.load(url)
        XCTAssertEqual(loaded.size.width, 120)
        XCTAssertEqual(loaded.size.height, 80)
        try Data("not an image".utf8).write(to: url)
        XCTAssertThrowsError(try ImagePreviewDecoder.load(url))
    }

    func testLargeImageIsBoundedAndOversizeFileRejectedBeforeDecode() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 5000, height: 10), format: format).image { ctx in
            UIColor.blue.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 5000, height: 10))
        }
        let file = root.appendingPathComponent("wide.png")
        try XCTUnwrap(image.pngData()).write(to: file)
        XCTAssertLessThanOrEqual(try ImagePreviewDecoder.load(file).size.width, 4096)
        XCTAssertLessThanOrEqual(ImagePreviewDecoder.bounded(image).size.width, 4096)
        let handle = try FileHandle(forWritingTo: file)
        try handle.truncate(atOffset: UInt64(ImagePreviewDecoder.maximumFileBytes + 1)); try handle.close()
        XCTAssertThrowsError(try ImagePreviewDecoder.load(file)) { error in
            XCTAssertEqual(error.localizedDescription, ImagePreviewError.tooLarge.localizedDescription)
        }
    }

    @MainActor
    func testCancelledAndReplacedImageRequestRejectsLateCompletions() {
        let request = ImagePreviewRequest()
        let first = request.begin()
        XCTAssertTrue(request.accepts(first))
        let second = request.begin()
        XCTAssertFalse(request.accepts(first)); XCTAssertTrue(request.accepts(second))
        request.cancel(); XCTAssertFalse(request.accepts(second))
        request.appear(); XCTAssertFalse(request.accepts(second))
        XCTAssertTrue(request.accepts(request.begin()))
    }

    func testRetinaCameraImageUsesPixelLimit() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2500, height: 10), format: format).image { ctx in
            UIColor.blue.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 2500, height: 10))
        }
        XCTAssertEqual(try XCTUnwrap(image.cgImage).width, 5000)
        let preview = ImagePreviewDecoder.bounded(image)
        XCTAssertLessThanOrEqual(try XCTUnwrap(preview.cgImage).width, 4096)
    }

    @MainActor
    func testImageScreenRendersWithoutAccountAndZoomViewMaintainsBounds() {
        let controller = UIHostingController(rootView: ImageToolsView())
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller; window.makeKeyAndVisible()
        controller.view.layoutIfNeeded()
        XCTAssertNotNil(controller.view)
        let scroll = ImageZoomScrollView()
        scroll.frame = CGRect(x: 0, y: 0, width: 390, height: 600)
        let image = UIImageView()
        scroll.imageView = image; scroll.addSubview(image)
        scroll.layoutIfNeeded()
        XCTAssertEqual(image.frame, scroll.bounds)
        scroll.frame.size = CGSize(width: 700, height: 320)
        scroll.setNeedsLayout(); scroll.layoutIfNeeded()
        XCTAssertEqual(image.frame, scroll.bounds)
        window.isHidden = true
    }
}

// This exercises actual WebKit FileReader and image decoding in a consuming page.
// DataTransfer selects a synthetic fixture; it does not claim system-picker UI
// automation or model vision. Production retains WebKit's standard file picker.
@MainActor
final class ImageConsumptionTests: XCTestCase {
    final class LoadedPage: NSObject, WKNavigationDelegate {
        var completed: (() -> Void)?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { completed?() }
    }
    final class ConsumedImage: NSObject, WKScriptMessageHandler {
        var completed: (([String: Any]) -> Void)?
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if let value = message.body as? [String: Any] { completed?(value) }
        }
    }
    func testWebAppReceivesSelectedImageBytesAndDecodesPreview() async throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let fixture = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 24), format: format).image { ctx in
            UIColor.orange.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 32, height: 24))
        }
        let data = try XCTUnwrap(fixture.pngData())
        let loaded = expectation(description: "Local image-consuming page loaded")
        let delegate = LoadedPage(); delegate.completed = { loaded.fulfill() }
        let consumed = expectation(description: "Web page consumed image bytes")
        let consumer = ConsumedImage()
        var received: [String: Any]?
        consumer.completed = { value in received = value; consumed.fulfill() }
        let config = WKWebViewConfiguration()
        config.userContentController.add(consumer, name: "imageFixture")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: config)
        web.navigationDelegate = delegate
        defer {
            web.stopLoading(); web.navigationDelegate = nil
            config.userContentController.removeScriptMessageHandler(forName: "imageFixture")
        }
        web.loadHTMLString("""
        <!doctype html><html><body><label>Choose image<input id="photo" type="file" accept="image/*"></label><img id="preview" alt="Selected image"><script>
        window.consumed = new Promise((resolve,reject) => {
          document.getElementById('photo').addEventListener('change', async event => {
            try {
              const file = event.target.files[0];
              const reader = new FileReader();
              const value = await new Promise((done,fail) => {reader.onload=()=>done(reader.result);reader.onerror=fail;reader.readAsDataURL(file)});
              const preview = document.getElementById('preview'); preview.src = value; await preview.decode();
              resolve({name:file.name,size:file.size,type:file.type,data:value,width:preview.naturalWidth,height:preview.naturalHeight});
            } catch (error) {reject(error)}
          });
        });
        </script></body></html>
        """, baseURL: URL(string: "https://image-fixture.invalid/"))
        await fulfillment(of: [loaded], timeout: 20)
        // Use the stable Objective-C WebKit completion/message APIs. The async
        // Swift overlay adds a libswiftWebKit dependency unavailable on some
        // supported simulator runtimes; the actual page assertions are unchanged.
        let payload = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: [data.base64EncodedString()]), encoding: .utf8))
        web.evaluateJavaScript("""
        (() => {
        const payload = \(payload)[0];
        window.consumed.then(value => window.webkit.messageHandlers.imageFixture.postMessage(value),
          error => window.webkit.messageHandlers.imageFixture.postMessage({error:String(error)}));
        const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
        const file = new File([bytes], 'fixture.png', {type:'image/png'});
        const transfer = new DataTransfer(); transfer.items.add(file);
        const input = document.getElementById('photo'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
        })()
        """) { _, error in
            if let error { consumer.completed?(["error": error.localizedDescription]) }
        }
        await fulfillment(of: [consumed], timeout: 20)
        let value = try XCTUnwrap(received)
        XCTAssertNil(value["error"])
        XCTAssertEqual(value["name"] as? String, "fixture.png")
        XCTAssertEqual(value["size"] as? Int, data.count)
        XCTAssertEqual(value["type"] as? String, "image/png")
        XCTAssertEqual(value["data"] as? String, "data:image/png;base64," + data.base64EncodedString())
        XCTAssertEqual(value["width"] as? Int, 32)
        XCTAssertEqual(value["height"] as? Int, 24)
    }
}
