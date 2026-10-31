import Foundation
import CryptoKit

struct LocalModel: Identifiable, Equatable {
    let id: String
    let title: String
    let repository: String
    let revision: String
    let filename: String
    let bytes: Int64
    let sha256: String
    let minimumRAM: UInt64
    var url: URL { URL(string: "https://huggingface.co/\(repository)/resolve/\(revision)/\(filename)?download=true")! }
    var source: URL { URL(string: "https://huggingface.co/\(repository)")! }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .decimal) }
    static let e4b = LocalModel(id: "gemma4-e4b", title: "Gemma 4 E4B", repository: "litert-community/gemma-4-E4B-it-litert-lm", revision: "e6a3892a8c22cf87ff99583996149cf3cb32452b", filename: "gemma-4-E4B-it.litertlm", bytes: 3_659_530_240, sha256: "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0", minimumRAM: 7 * 1_073_741_824)
    static let e2b = LocalModel(id: "gemma4-e2b", title: "Gemma 4 E2B", repository: "litert-community/gemma-4-E2B-it-litert-lm", revision: "1caa527c1e88b55f046fcd8d2b4265606680663d", filename: "gemma-4-E2B-it.litertlm", bytes: 2_588_147_712, sha256: "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c", minimumRAM: 4 * 1_073_741_824)
    static let all = [e4b, e2b]
    static func recommended(memory: UInt64) -> LocalModel { memory >= 11 * 1_073_741_824 ? e4b : e2b }
    static func validResponse(status: Int, expected: Int64, advertised: Int64, contentRange: String? = nil) -> Bool {
        if status == 200 { return advertised < 0 || advertised == expected }
        guard status == 206, let range = contentRange, range.hasPrefix("bytes ") else { return false }
        let parts = range.dropFirst(6).split(separator: "/")
        guard parts.count == 2, Int64(parts[1]) == expected else { return false }
        let bounds = parts[0].split(separator: "-")
        guard bounds.count == 2, let start = Int64(bounds[0]), let end = Int64(bounds[1]),
              start >= 0, end == expected - 1, start <= end else { return false }
        return advertised < 0 || advertised == end - start + 1
    }
    static func verify(_ url: URL, bytes: Int64, sha256: String) throws {
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard size == Int(bytes) else { throw LocalModelError.message("下载文件不完整，请重新下载。") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { digest.update(data: chunk) }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == sha256 else {
            throw LocalModelError.message("文件校验失败，未安装这个模型。请重新下载。")
        }
    }
}
enum LocalModelError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(value) = self { return value }; return nil }
}

// A separate delegate queue moves and verifies multi-GB files without blocking SwiftUI.
final class ModelDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let model: LocalModel
    let destination: URL
    let resumeURL: URL
    let progress: @Sendable (Double) -> Void
    let completion: @Sendable (Result<URL, Error>) -> Void
    private var session: URLSession!
    private var task: URLSessionDownloadTask?
    private var installed = false
    private var finished = false
    private var paused = false
    private let stateLock = NSLock()
    init(model: LocalModel, destination: URL, cellular: Bool, configuration: URLSessionConfiguration? = nil,
         progress: @escaping @Sendable (Double) -> Void,
         completion: @escaping @Sendable (Result<URL, Error>) -> Void) {
        self.model = model; self.destination = destination
        self.resumeURL = destination.appendingPathExtension("resume")
        self.progress = progress; self.completion = completion
        super.init()
        let config = configuration ?? URLSessionConfiguration.default
        config.allowsCellularAccess = cellular
        config.waitsForConnectivity = true
        config.timeoutIntervalForResource = 24 * 3600
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }
    func start() {
        if let resume = try? Data(contentsOf: resumeURL) {
            task = session.downloadTask(withResumeData: resume)
        } else { task = session.downloadTask(with: model.url) }
        task?.resume()
    }
    private func finish(_ result: Result<URL, Error>, resumeData: Data? = nil) {
        stateLock.lock()
        guard !finished else { stateLock.unlock(); return }
        if let resumeData {
            try? resumeData.write(to: resumeURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        finished = true; stateLock.unlock()
        completion(result)
    }
    private var isPaused: Bool {
        stateLock.lock(); defer { stateLock.unlock() }; return paused
    }
    func pause() {
        stateLock.lock()
        guard !finished, !paused else { stateLock.unlock(); return }
        paused = true; stateLock.unlock()
        task?.cancel { [self] data in
            finish(.failure(LocalModelError.message("下载已暂停，可继续下载。")), resumeData: data)
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > model.bytes {
            downloadTask.cancel()
            return
        }
        progress(min(0.99, Double(totalBytesWritten) / Double(model.bytes)))
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response as? HTTPURLResponse,
                  LocalModel.validResponse(status: response.statusCode, expected: model.bytes, advertised: response.expectedContentLength, contentRange: response.value(forHTTPHeaderField: "Content-Range")) else {
                throw LocalModelError.message("官方模型下载未成功，请检查网络后重试。")
            }
            guard !isPaused else { return }
            try LocalModel.verify(location, bytes: model.bytes, sha256: model.sha256)
            stateLock.lock()
            guard !paused else { stateLock.unlock(); return }
            // Serialize installation with cancellation; no resume callback can resurrect a deleted file.
            defer { stateLock.unlock() }
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: location, to: destination)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
            try? FileManager.default.removeItem(at: resumeURL)
            installed = true
        } catch { finish(.failure(error)); return }
        if installed { finish(.success(destination)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate() }
        if let error, !installed, !isPaused {
            let nsError = error as NSError
            let data = nsError.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
            finish(.failure(LocalModelError.message("下载中断，可继续下载。若无法继续，请清除未完成下载后重试。")), resumeData: data)
        }
    }
}
