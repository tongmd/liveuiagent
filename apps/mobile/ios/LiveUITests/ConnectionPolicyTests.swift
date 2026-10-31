import XCTest
@testable import LiveUI

final class ConnectionPolicyTests: XCTestCase {
    private let connection = Connection(address: "https://liveui.example/liveui/", username: "user", password: "secret", realm: "LiveUIAgent")
    func testRejectsCleartextAndURLCredentials() {
        for address in ["http://liveui.example/liveui/", "https://" + "user:secret" + "@liveui.example/", "https://liveui.example/?token=secret", "https://liveui.example/#secret", "file:///tmp/index.html"] {
            XCTAssertNil(Connection.validURL(address))
        }
        XCTAssertNotNil(Connection.validURL("https://liveui.example:8443/liveui/"))
    }
    func testExactOrigin() {
        XCTAssertTrue(connection.contains(URL(string: "https://LIVEUI.example:443/api")!))
        for address in ["http://liveui.example/", "https://liveui.example:8443/", "https://liveui.example.attacker.test/", "https://attacker.test/", "https://" + "injected:credential" + "@liveui.example/"] {
            XCTAssertFalse(connection.contains(URL(string: address)!))
        }
    }
    func testExactAuthenticationScopeAndSingleAttempt() {
        func accepts(_ host: String = "liveui.example", _ port: Int = 443, _ scheme: String = "https", _ realm: String = "LiveUIAgent", _ method: String = NSURLAuthenticationMethodHTTPBasic, _ failures: Int = 0) -> Bool {
            connection.accepts(host: host, port: port, protocolName: scheme, realm: realm, method: method, failures: failures)
        }
        XCTAssertTrue(accepts())
        XCTAssertFalse(accepts("attacker.test"))
        XCTAssertFalse(accepts("liveui.example", 8443))
        XCTAssertFalse(accepts("liveui.example", 443, "http"))
        XCTAssertFalse(accepts("liveui.example", 443, "https", "other"))
        XCTAssertFalse(accepts("liveui.example", 443, "https", "LiveUIAgent", NSURLAuthenticationMethodServerTrust))
        XCTAssertFalse(accepts("liveui.example", 443, "https", "LiveUIAgent", NSURLAuthenticationMethodHTTPBasic, 1))
    }
}

final class OnboardingPolicyTests: XCTestCase {
    func testFirstLoginReturnAndExplicitReplay() {
        XCTAssertFalse(OnboardingPolicy.shouldPresent(signedIn: false, completed: false))
        XCTAssertTrue(OnboardingPolicy.shouldPresent(signedIn: true, completed: false))
        XCTAssertFalse(OnboardingPolicy.shouldPresent(signedIn: true, completed: true))
        XCTAssertFalse(OnboardingPolicy.shouldPresent(signedIn: false, completed: true))
        // Logging out does not reset the guide preference. Replay is an explicit
        // account-menu presentation and never writes this preference to false.
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(true, forKey: "liveui.onboarding.completed.v1")
        XCTAssertFalse(OnboardingPolicy.shouldPresent(signedIn: true, completed: defaults.bool(forKey: "liveui.onboarding.completed.v1")))
    }
    func testReduceMotionHasNoLaunchDelay() {
        XCTAssertEqual(OnboardingPolicy.launchDelay(reduceMotion: true), 0)
        XCTAssertLessThanOrEqual(OnboardingPolicy.launchDelay(reduceMotion: false), 700_000_000)
    }
    func testCancelledOrSupersededLoginCannotAcceptLateSuccess() {
        var attempt = LoginAttempt()
        let old = attempt.begin()
        attempt.cancel()
        XCTAssertFalse(attempt.isCurrent(old))
        let next = attempt.begin()
        XCTAssertFalse(attempt.isCurrent(old))
        XCTAssertTrue(attempt.isCurrent(next))
        attempt.cancel()
        XCTAssertFalse(attempt.isCurrent(next))
    }
    func testRejectsSavedCustomEndpointRatherThanMovingCredentials() {
        XCTAssertTrue(Connection(address: Connection.defaultAddress, username: "u", password: "p", realm: "LiveUIAgent").isAppConnection)
        for address in ["https://other.example/liveui/", "https://liveui.stonezhang.com:8443/liveui/", "https://liveui.stonezhang.com/intern/"] {
            XCTAssertFalse(Connection(address: address, username: "u", password: "p", realm: "LiveUIAgent").isAppConnection)
        }
    }
    func testFriendlyErrorsDistinguishCredentialsFromNetwork() {
        XCTAssertEqual(LoginFeedback.message(for: AppLoginFailure.credentials), "账号或密码不正确，请检查后重试。")
        XCTAssertEqual(LoginFeedback.message(for: URLError(.notConnectedToInternet)), "网络连接不顺畅，请检查网络后重试。")
        XCTAssertEqual(LoginFeedback.message(for: URLError(.timedOut)), "网络连接不顺畅，请检查网络后重试。")
        XCTAssertEqual(LoginFeedback.message(for: NSError(domain: "private-backend-url", code: 503)), "暂时无法登录，请稍后重试。")
    }
}
