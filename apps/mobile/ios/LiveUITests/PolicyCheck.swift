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
        precondition(!OnboardingPolicy.shouldPresent(signedIn: false, completed: false))
        precondition(OnboardingPolicy.shouldPresent(signedIn: true, completed: false))
        precondition(!OnboardingPolicy.shouldPresent(signedIn: true, completed: true))
        precondition(!OnboardingPolicy.shouldPresent(signedIn: false, completed: true))
        precondition(OnboardingPolicy.launchDelay(reduceMotion: true) == 0)
        precondition(OnboardingPolicy.launchDelay(reduceMotion: false) <= 700_000_000)
        var attempts = LoginAttempt()
        let old = attempts.begin()
        attempts.cancel()
        precondition(!attempts.isCurrent(old))
        let current = attempts.begin()
        precondition(!attempts.isCurrent(old) && attempts.isCurrent(current))
        precondition(!c.isAppConnection)
        precondition(Connection(address: Connection.defaultAddress, username: "u", password: "p", realm: "LiveUIAgent").isAppConnection)
        precondition(LoginFeedback.message(for: AppLoginFailure.credentials).contains("username and password"))
        precondition(LoginFeedback.message(for: URLError(.notConnectedToInternet)).contains("connection"))
        precondition(!LoginFeedback.message(for: NSError(domain: "secret-url", code: 500)).contains("secret-url"))
        print("31 connection/authentication and first-use policy checks passed")
    }
}
