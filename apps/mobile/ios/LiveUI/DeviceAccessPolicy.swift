import Foundation

// A stopped or replaced request cannot accept a late system callback.
struct DeviceAccessSession {
    private(set) var id: UUID?
    mutating func begin() -> UUID { let value = UUID(); id = value; return value }
    mutating func stop() { id = nil }
    func accepts(_ value: UUID) -> Bool { id == value }
}

enum DeviceAccessPolicy {
    static let discoverySeconds: Double = 15
    static let locationSeconds: Double = 20
    static let sensorSeconds: Double = 60
    static let maximumResults = 50
    static let bonjourTypes = ["_http._tcp", "_mqtt._tcp"]
    static func acceptsLocation(timestamp: Date, accuracy: Double, now: Date = Date()) -> Bool {
        accuracy.isFinite && accuracy >= 0 && abs(timestamp.timeIntervalSince(now)) <= 30
    }
    static func resultKey(name: String, type: String, domain: String) -> String {
        // Length prefixes avoid collisions when device names contain separators.
        [name, type, domain].map { "\($0.utf8.count):\($0)" }.joined()
    }
}
