import Foundation
import Security

enum CredentialStore {
    private static let service = "com.stonezhang.liveui.connection"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "connection"]
    }
    static func load() -> Connection? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(Connection.self, from: data)
    }
    static func loadForApp() -> Connection? {
        guard let saved = load() else { return nil }
        guard saved.isAppConnection else { remove(); return nil }
        return saved
    }
    static func save(_ connection: Connection) throws {
        let data = try JSONEncoder().encode(connection)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let result = SecItemAdd(item as CFDictionary, nil)
            guard result == errSecSuccess else { throw StoreError.failed }
        } else if status != errSecSuccess { throw StoreError.failed }
    }
    static func remove() { SecItemDelete(query as CFDictionary) }
    enum StoreError: Error { case failed }
}

final class LoginVerifier: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let connection: Connection
    private let authLock = NSLock()
    private var challenged = false
    private var rejectedCredentials = false
    private func authenticationState() -> (challenged: Bool, rejected: Bool) {
        authLock.lock(); defer { authLock.unlock() }
        return (challenged, rejectedCredentials)
    }
    init(connection: Connection) { self.connection = connection }
    func verify() async throws {
        guard let url = connection.url else { throw LoginError.invalidAddress }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 45
        config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let response: URLResponse
        do { (_, response) = try await session.data(from: url) }
        catch {
            if authenticationState().rejected { throw AppLoginFailure.credentials }
            throw error
        }
        guard let http = response as? HTTPURLResponse else { throw AppLoginFailure.unavailable }
        if http.statusCode == 401 || http.statusCode == 403 { throw AppLoginFailure.credentials }
        guard http.statusCode == 200, response.url.map(connection.contains) == true,
              response.mimeType?.lowercased() == "text/html", authenticationState().challenged else { throw AppLoginFailure.unavailable }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else if connection.accepts(challenge) {
            authLock.lock(); challenged = true; authLock.unlock()
            completionHandler(.useCredential, connection.credential)
        } else {
            let space = challenge.protectionSpace
            if challenge.previousFailureCount > 0, connection.accepts(host: space.host, port: space.port,
                protocolName: space.protocol, realm: space.realm, method: space.authenticationMethod, failures: 0) {
                authLock.lock(); rejectedCredentials = true; authLock.unlock()
            }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(connection.contains) == true ? request : nil)
    }
    enum LoginError: Error { case invalidAddress, rejected }
}
