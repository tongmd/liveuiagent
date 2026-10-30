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
        for address in ["http://liveui.example/", "https://liveui.example:8443/", "https://liveui.example.attacker.test/", "https://attacker.test/"] {
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
