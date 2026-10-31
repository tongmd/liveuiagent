import XCTest
import CryptoKit
@testable import LiveUI

final class LocalModelTests: XCTestCase {
    func testCatalogPinningAndDeviceChoice() {
        XCTAssertEqual(LocalModel.recommended(memory: 8 * 1_073_741_824), .e2b)
        XCTAssertEqual(LocalModel.recommended(memory: 12 * 1_073_741_824), .e4b)
        for model in LocalModel.all {
            XCTAssertEqual(model.url.scheme, "https")
            XCTAssertEqual(model.url.host, "huggingface.co")
            XCTAssertTrue(model.url.path.contains(model.revision))
            XCTAssertEqual(model.sha256.count, 64)
        }
    }
    func testRejectsErrorAndInconsistentResumeResponses() {
        XCTAssertTrue(LocalModel.validResponse(status: 200, expected: 100, advertised: 100))
        XCTAssertTrue(LocalModel.validResponse(status: 206, expected: 100, advertised: 70, contentRange: "bytes 30-99/100"))
        XCTAssertFalse(LocalModel.validResponse(status: 401, expected: 100, advertised: 100))
        XCTAssertFalse(LocalModel.validResponse(status: 200, expected: 100, advertised: 120))
        XCTAssertFalse(LocalModel.validResponse(status: 206, expected: 100, advertised: 70, contentRange: "bytes 30-99/101"))
        XCTAssertFalse(LocalModel.validResponse(status: 206, expected: 100, advertised: 70, contentRange: "bytes 31-99/100"))
        XCTAssertFalse(LocalModel.validResponse(status: 206, expected: 100, advertised: 70))
    }
    func testWholeFileHashRejectsTruncationAndSameLengthCorruption() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let data = Data("model bytes".utf8)
        try data.write(to: path)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        XCTAssertNoThrow(try LocalModel.verify(path, bytes: Int64(data.count), sha256: sha))
        XCTAssertThrowsError(try LocalModel.verify(path, bytes: Int64(data.count + 1), sha256: sha))
        try Data("model byteX".utf8).write(to: path)
        XCTAssertThrowsError(try LocalModel.verify(path, bytes: Int64(data.count), sha256: sha))
    }
}
