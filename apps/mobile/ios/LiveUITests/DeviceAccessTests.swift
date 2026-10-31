import XCTest
@testable import LiveUI

final class DeviceAccessTests: XCTestCase {
    func testPermissionPromptDoesNotConsumeOperationWindowAndGrantStartsOnlyOnce() {
        var window = DevicePermissionWindow()
        let request = window.begin()
        XCTAssertNil(window.startedAt)
        let afterLongConsent = Date(timeIntervalSince1970: 10_000)
        XCTAssertTrue(window.accepts(request))
        XCTAssertEqual(window.startAuthorizedOperation(at: afterLongConsent), request)
        XCTAssertEqual(window.startedAt, afterLongConsent)
        XCTAssertNil(window.startAuthorizedOperation(at: afterLongConsent.addingTimeInterval(1)))
        XCTAssertEqual(window.startedAt, afterLongConsent)
    }
    func testDenialOrBackgroundCancellationRejectsLateGrantAndAllowsFreshRequest() {
        var window = DevicePermissionWindow()
        let pending = window.begin()
        window.stop() // Same terminal operation used by denial and stopAll.
        XCTAssertFalse(window.accepts(pending))
        XCTAssertNil(window.startAuthorizedOperation())
        let next = window.begin()
        XCTAssertEqual(window.startAuthorizedOperation(), next)
        window.stop()
        XCTAssertFalse(window.accepts(next))
        XCTAssertNil(window.startedAt)
    }
    func testStoppedSessionRejectsLateReadings() {
        var session = DeviceAccessSession()
        let request = session.begin()
        XCTAssertTrue(session.accepts(request))
        session.stop()
        XCTAssertFalse(session.accepts(request))
        XCTAssertNil(session.id)
    }
    func testRestartRejectsEarlierDiscoveryCallbacks() {
        var session = DeviceAccessSession()
        let first = session.begin()
        let second = session.begin()
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(session.accepts(first))
        XCTAssertTrue(session.accepts(second))
    }
    func testRejectsStaleInvalidOrFutureLocation() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(DeviceAccessPolicy.acceptsLocation(timestamp: now, accuracy: 15, now: now))
        XCTAssertTrue(DeviceAccessPolicy.acceptsLocation(timestamp: now.addingTimeInterval(-10), accuracy: 1000, now: now))
        XCTAssertFalse(DeviceAccessPolicy.acceptsLocation(timestamp: now.addingTimeInterval(-31), accuracy: 15, now: now))
        XCTAssertFalse(DeviceAccessPolicy.acceptsLocation(timestamp: now.addingTimeInterval(31), accuracy: 15, now: now))
        XCTAssertFalse(DeviceAccessPolicy.acceptsLocation(timestamp: now, accuracy: -1, now: now))
        XCTAssertFalse(DeviceAccessPolicy.acceptsLocation(timestamp: now, accuracy: .nan, now: now))
        XCTAssertFalse(DeviceAccessPolicy.acceptsLocation(timestamp: now, accuracy: .infinity, now: now))
    }
    func testDiscoveryIsBoundedAndServiceTypesExplicit() {
        XCTAssertEqual(DeviceAccessPolicy.bonjourTypes, ["_http._tcp", "_mqtt._tcp"])
        XCTAssertEqual(DeviceAccessPolicy.maximumResults, 50)
        XCTAssertEqual(DeviceAccessPolicy.discoverySeconds, 15)
        XCTAssertEqual(DeviceAccessPolicy.locationSeconds, 20)
        XCTAssertEqual(DeviceAccessPolicy.sensorSeconds, 60)
    }
    func testServiceIdentityIncludesTypeDomainAndDoesNotCollideOnSeparators() {
        XCTAssertNotEqual(DeviceAccessPolicy.resultKey(name: "lab", type: "_http._tcp", domain: "local."),
                          DeviceAccessPolicy.resultKey(name: "lab", type: "_mqtt._tcp", domain: "local."))
        XCTAssertNotEqual(DeviceAccessPolicy.resultKey(name: "a:b", type: "c", domain: "d"),
                          DeviceAccessPolicy.resultKey(name: "a", type: "b:c", domain: "d"))
    }
    @MainActor func testOpeningScreenDoesNotStartHardwareAndStopIsIdempotent() {
        let model = DeviceAccessModel()
        XCTAssertFalse(model.scanningBluetooth)
        XCTAssertFalse(model.scanningNetwork)
        XCTAssertFalse(model.readingSensors)
        XCTAssertFalse(model.locating)
        XCTAssertTrue(model.bluetoothDevices.isEmpty)
        XCTAssertTrue(model.networkDevices.isEmpty)
        XCTAssertTrue(model.sensorReadings.isEmpty)
        model.stopAll(); model.stopAll()
        XCTAssertFalse(model.scanningBluetooth)
        XCTAssertFalse(model.scanningNetwork)
        XCTAssertFalse(model.readingSensors)
        XCTAssertFalse(model.locating)
        XCTAssertTrue(model.sensorReadings.isEmpty)
    }
}

import WebKit

@MainActor
final class DeviceObservationTransferTests: XCTestCase {
    func testRealModelBoundaryPreservesValuesUnitsSourceAndTimestamp() throws {
        // Synthetic input at the same recording boundary used by hardware callbacks.
        // This tests serialization, not physical hardware availability.
        let model = DeviceAccessModel()
        let time = Date(timeIntervalSince1970: 1000)
        model.record(DeviceObservation(id: "sensor:acceleration", source: "CoreMotion accelerometer", capturedAt: time,
            values: ["x": 0.25, "y": -0.5, "z": 1], units: ["x":"g","y":"g","z":"g"], details: [:]))
        let envelope = model.snapshot()
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: envelope.encoded()) as? [String: Any])
        let observations = try XCTUnwrap(json["observations"] as? [[String: Any]])
        XCTAssertEqual(observations.count, 1)
        XCTAssertEqual(observations[0]["source"] as? String, "CoreMotion accelerometer")
        XCTAssertEqual(observations[0]["capturedAt"] as? String, "1970-01-01T00:16:40Z")
        XCTAssertEqual((observations[0]["values"] as? [String: Double])?["x"], 0.25)
        XCTAssertEqual((observations[0]["units"] as? [String: String])?["x"], "g")
        XCTAssertTrue(envelope.readableText().contains("x: 0.25 g"))
        model.stopAll()
        XCTAssertTrue(model.snapshot().observations.isEmpty)
    }

    func testCurrentAppComposerReceivesSafeDataAndRetainsDraftWithoutSending() async throws {
        let web = WKWebView()
        web.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        let window = present(web); defer { window.isHidden = true }
        let ready = expectation(description: "Loaded composer fixture")
        let navigation = DeviceTestNavigation(ready)
        web.navigationDelegate = navigation
        web.loadHTMLString("""
        <html><body>
        <form class="liveui-composer"><textarea>Global draft</textarea></form>
        <section class="app-sheet" data-app-id="fixture-app">
        <form class="rich-workspace-request"><textarea>Keep this task</textarea><button>Send</button></form>
        </section>
        <script>window.sent=0;window.inputs=0;document.addEventListener('submit',e=>{e.preventDefault();window.sent++});document.addEventListener('input',e=>{window.inputs++;window.received=e.target.value});</script>
        </body></html>
        """, baseURL: URL(string: "https://example.invalid"))
        await fulfillment(of: [ready], timeout: 15)
        let dangerousName = "Desk');window.pwned=true;//\n\"quoted\""
        let model = DeviceAccessModel()
        model.record(DeviceObservation(id: "ble:fixture", source: "CoreBluetooth advertisement", capturedAt: Date(timeIntervalSince1970: 1000),
            values: ["signal":-55], units: ["signal":"dBm"], details: ["name": dangerousName]))
        let text = model.snapshot().readableText()
        let requestID = UUID()
        let receipt = try await transfer(text, requestID: requestID, web: web) as? [String: Any]
        XCTAssertEqual(receipt?["ok"] as? Bool, true)
        let retried = try await transfer(text, requestID: requestID, web: web) as? [String: Any]
        XCTAssertEqual(retried?["requestID"] as? String, requestID.uuidString)
        let state = try await execute("return {draft:document.querySelector('.rich-workspace-request textarea').value,global:document.querySelector('.liveui-composer textarea').value,sent:window.sent,inputs:window.inputs,received:window.received,pwned:!!window.pwned,app:document.querySelector('.app-sheet').dataset.appId}", web: web) as? [String: Any]
        XCTAssertEqual(state?["draft"] as? String, "Keep this task\n\n" + text)
        XCTAssertEqual(state?["received"] as? String, "Keep this task\n\n" + text)
        XCTAssertEqual(state?["global"] as? String, "Global draft")
        XCTAssertEqual(state?["app"] as? String, "fixture-app")
        XCTAssertEqual(state?["sent"] as? Int, 0)
        XCTAssertEqual(state?["inputs"] as? Int, 1)
        XCTAssertEqual(state?["pwned"] as? Bool, false)
        web.stopLoading(); web.navigationDelegate = nil
    }


    func testTypingDuringAcknowledgementPreservesNewTextAndRetryDoesNotAppendAgain() async throws {
        let web = WKWebView(); web.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        let window = present(web); defer { window.isHidden = true }
        let ready = expectation(description: "Loaded concurrent typing fixture")
        let navigation = DeviceTestNavigation(ready); web.navigationDelegate = navigation
        web.loadHTMLString("""
        <form class="liveui-composer"><textarea>Original draft</textarea></form>
        <script>
        window.inputs=0;window.sent=0;
        document.addEventListener('submit',e=>{e.preventDefault();window.sent++});
        document.addEventListener('input',e=>{
          window.inputs++;
          if(window.inputs===1)requestAnimationFrame(()=>{e.target.value+='\\nMy next thought';});
        });
        </script>
        """, baseURL: URL(string: "https://example.invalid"))
        await fulfillment(of: [ready], timeout: 15)
        let requestID = UUID(), text = "Accelerometer observed 12:00 UTC: x 0.25 g"
        let first = try await transfer(text, requestID: requestID, web: web) as? [String: Any]
        XCTAssertEqual(first?["ok"] as? Bool, true)
        let second = try await transfer(text, requestID: requestID, web: web) as? [String: Any]
        XCTAssertEqual(second?["ok"] as? Bool, true)
        let state = try await execute("return {value:document.querySelector('textarea').value,inputs:window.inputs,sent:window.sent}", web: web) as? [String: Any]
        XCTAssertEqual(state?["value"] as? String, "Original draft\n\n" + text + "\nMy next thought")
        XCTAssertEqual(state?["inputs"] as? Int, 1)
        XCTAssertEqual(state?["sent"] as? Int, 0)
        web.stopLoading(); web.navigationDelegate = nil
    }

    func testMissingCurrentAppComposerDoesNotFallBackOrClaimSuccess() async throws {
        let web = WKWebView(); web.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
        let window = present(web); defer { window.isHidden = true }
        let ready = expectation(description: "Loaded missing composer fixture")
        let navigation = DeviceTestNavigation(ready); web.navigationDelegate = navigation
        web.loadHTMLString("<form class='liveui-composer'><textarea>Keep global</textarea></form><section class='app-sheet'>An app without an instruction field</section>", baseURL: URL(string: "https://example.invalid"))
        await fulfillment(of: [ready], timeout: 15)
        let result = try await transfer("Actual reading", requestID: UUID(), web: web) as? [String: Any]
        XCTAssertEqual(result?["ok"] as? Bool, false)
        let value = try await execute("return document.querySelector('textarea').value", web: web) as? String
        XCTAssertEqual(value, "Keep global")
        web.stopLoading(); web.navigationDelegate = nil
    }

    private func present(_ web: WKWebView) -> UIWindow {
        let window: UIWindow
        if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first { window = UIWindow(windowScene: scene) }
        else { window = UIWindow(frame: web.frame) }
        window.frame = web.frame; window.rootViewController = UIViewController()
        window.rootViewController?.view.addSubview(web); window.makeKeyAndVisible()
        return window
    }

    private func transfer(_ text: String, requestID: UUID, web: WKWebView) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            DeviceWorkspaceScriptRunner.run(text: text, requestID: requestID, in: web) { result in continuation.resume(with: result) }
        }
    }
    private func execute(_ script: String, web: WKWebView) async throws -> Any {
        try await withCheckedThrowingContinuation { continuation in
            web.evaluateJavaScript("(() => { \(script) })()") { value, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: value ?? NSNull()) }
            }
        }
    }
}

private final class DeviceTestNavigation: NSObject, WKNavigationDelegate {
    let ready: XCTestExpectation
    init(_ ready: XCTestExpectation) { self.ready = ready }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready.fulfill() }
}
