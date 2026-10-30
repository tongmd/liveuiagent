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
