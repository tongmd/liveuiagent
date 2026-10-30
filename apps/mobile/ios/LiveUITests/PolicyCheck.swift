// Standalone Foundation check: see README. This does not exercise WKWebView or UIKit.
import Foundation
@main
struct PolicyCheck {
    static func main() {
        let c = Connection(address: "https://liveui.example/liveui/", username: "user", password: "secret", realm: "LiveUIAgent")
        for bad in ["http://liveui.example/", "https://" + "u:p" + "@liveui.example/", "https://liveui.example/?key=secret", "https://liveui.example/#x", "file:///tmp/a", "https://liveui.example:0/"] {
            precondition(Connection.validURL(bad) == nil)
        }
        precondition(c.contains(URL(string: "https://LIVEUI.example:443/api")!))
        for bad in ["http://liveui.example/", "https://liveui.example:444/", "https://liveui.example.attacker.test/", "https://" + "injected:credential" + "@liveui.example/"] {
            precondition(!c.contains(URL(string: bad)!))
        }
        func accepts(host: String = "liveui.example", port: Int = 443, scheme: String = "https", realm: String = "LiveUIAgent", method: String = NSURLAuthenticationMethodHTTPBasic, failures: Int = 0) -> Bool {
            c.accepts(host: host, port: port, protocolName: scheme, realm: realm, method: method, failures: failures)
        }
        precondition(accepts())
        precondition(!accepts(host: "elsewhere.test"))
        precondition(!accepts(port: 444))
        precondition(!accepts(scheme: "http"))
        precondition(!accepts(realm: "other"))
        precondition(!accepts(method: NSURLAuthenticationMethodServerTrust))
        precondition(!accepts(failures: 1))
        print("18 connection/authentication policy checks passed")
    }
}
