import Foundation

struct Connection: Codable, Equatable {
    static let defaultAddress = "https://liveui.stonezhang.com/liveui/"
    let address: String
    let username: String
    let password: String
    let realm: String

    var url: URL? { Self.validURL(address) }
    static func validURL(_ address: String) -> URL? {
        guard let parts = URLComponents(string: address), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else { return nil }
        return parts.url
    }
    func contains(_ candidate: URL) -> Bool {
        guard let base = url else { return false }
        return candidate.user == nil && candidate.password == nil
            && candidate.scheme?.lowercased() == "https" && candidate.host?.lowercased() == base.host?.lowercased()
            && (candidate.port ?? 443) == (base.port ?? 443)
    }
    func accepts(host: String, port: Int, protocolName: String?, realm: String?, method: String, failures: Int) -> Bool {
        guard let base = url else { return false }
        return failures == 0 && method == NSURLAuthenticationMethodHTTPBasic && protocolName?.lowercased() == "https"
            && host.lowercased() == base.host?.lowercased() && port == (base.port ?? 443) && realm == self.realm
    }
    func accepts(_ challenge: URLAuthenticationChallenge) -> Bool {
        let space = challenge.protectionSpace
        return accepts(host: space.host, port: space.port, protocolName: space.protocol,
                       realm: space.realm, method: space.authenticationMethod, failures: challenge.previousFailureCount)
    }
    var credential: URLCredential { URLCredential(user: username, password: password, persistence: .none) }
}

// A saved custom endpoint must never silently receive a new app login or migrate
// credentials to a different host. The distributed app has one fixed entry point.
extension Connection {
    var isAppConnection: Bool { address == Self.defaultAddress && realm == "LiveUIAgent" }
}

enum OnboardingPolicy {
    static func shouldPresent(signedIn: Bool, completed: Bool) -> Bool { signedIn && !completed }
    static func launchDelay(reduceMotion: Bool) -> UInt64 { reduceMotion ? 0 : 650_000_000 }
}

struct LoginAttempt {
    private var current: UUID?
    mutating func begin() -> UUID { let ticket = UUID(); current = ticket; return ticket }
    mutating func cancel() { current = nil }
    func isCurrent(_ ticket: UUID) -> Bool { current == ticket }
}

enum AppLoginFailure: Error { case credentials, unavailable }

enum LoginFeedback {
    static func message(for error: Error) -> String {
        if let failure = error as? AppLoginFailure {
            switch failure {
            case .credentials: return "账号或密码不正确，请检查后重试。"
            case .unavailable: return "暂时无法登录，请稍后重试。"
            }
        }
        let code = (error as NSError).code
        if (error as NSError).domain == NSURLErrorDomain {
            if code == NSURLErrorUserAuthenticationRequired || code == NSURLErrorUserCancelledAuthentication {
                return "账号或密码不正确，请检查后重试。"
            }
            if [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorCannotConnectToHost,
                NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorTimedOut].contains(code) {
                return "网络连接不顺畅，请检查网络后重试。"
            }
        }
        return "暂时无法登录，请稍后重试。"
    }
}
