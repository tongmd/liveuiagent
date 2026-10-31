import XCTest
@testable import LiveUI

final class DeviceAccessTests: XCTestCase {
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
