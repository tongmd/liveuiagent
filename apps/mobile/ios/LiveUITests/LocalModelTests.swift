import XCTest
import CryptoKit
@testable import LiveUI

final class LocalModelTests: XCTestCase {
    func testActualDownloadInstallsOnlyVerifiedFile() throws {
        let payload = Data("small official model fixture".utf8)
        try exerciseDownload(payload: payload, expectedSHA: SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(), succeeds: true)
        try exerciseDownload(payload: payload, expectedSHA: String(repeating: "0", count: 64), succeeds: false)
    }
    private func exerciseDownload(payload: Data, expectedSHA: String, succeeds: Bool) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        DownloadFixtureProtocol.payload = payload
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DownloadFixtureProtocol.self]
        let model = LocalModel(id: "test", title: "fixture", repository: "test", revision: "pin", filename: "test.litertlm", bytes: Int64(payload.count), sha256: expectedSHA, minimumRAM: 0)
        let target = folder.appendingPathComponent(model.filename)
        let finished = expectation(description: "download terminates")
        let transfer = ModelDownload(model: model, destination: target, cellular: false, configuration: config, progress: { _ in }, completion: { result in
            switch result {
            case .success: XCTAssertTrue(succeeds)
            case .failure: XCTAssertFalse(succeeds)
            }
            finished.fulfill()
        })
        transfer.start()
        wait(for: [finished], timeout: 15)
        XCTAssertEqual(FileManager.default.fileExists(atPath: target.path), succeeds)
        if succeeds { XCTAssertEqual(try Data(contentsOf: target), payload) }
    }
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

private final class DownloadFixtureProtocol: URLProtocol {
    static var payload = Data()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Self.payload
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "\(data.count)", "Content-Type": "application/octet-stream"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
