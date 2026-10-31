import XCTest
import UIKit
import SwiftUI
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
