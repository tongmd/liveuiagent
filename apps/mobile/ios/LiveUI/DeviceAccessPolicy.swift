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

struct DeviceObservation: Codable, Equatable {
    let id: String
    let source: String
    let capturedAt: Date
    let values: [String: Double]
    let units: [String: String]
    let details: [String: String]
}

struct DeviceObservationEnvelope: Codable {
    let format = "ulemi-device-observations-v1"
    let platform = "iOS"
    let createdAt: Date
    var transferID = UUID()
    let observations: [DeviceObservation]
    var availability: [String: String] = [:]

    func readableText() -> String {
        let date = ISO8601DateFormatter()
        let rows = observations.sorted { $0.id < $1.id }.map { sample in
            let values = sample.values.keys.sorted().map { key in
                "\(key): \(sample.values[key]!)\(sample.units[key].map { " " + $0 } ?? "")"
            }
            let details = sample.details.keys.sorted().map { "\($0): \(sample.details[$0]!)" }
            return "• \(sample.source) observed \(date.string(from: sample.capturedAt))\n  " + (values + details).joined(separator: "; ")
        }
        return "Phone observations (iOS, prepared \(date.string(from: createdAt)))\n" + rows.joined(separator: "\n") + (availability.isEmpty ? "" : "\nStatus: " + availability.keys.sorted().map { "\($0): \(availability[$0]!)" }.joined(separator: "; "))
    }
    func encoded() throws -> Data {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }
}

enum DeviceWorkspaceTransfer {
    // JSON encoding keeps device names and readings as data, never JavaScript.
    static func script(text: String, requestID: UUID = UUID()) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [text, requestID.uuidString])
        guard let json = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
        return """
        (() => {
          const [text, requestID] = \(json);
          const receipts = window.__ulemiDeviceObservationReceipts ||= Object.create(null);
          if (receipts[requestID]?.ok || receipts[requestID]?.pending) return receipts[requestID];
          const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
          const sheet = [...document.querySelectorAll('.app-sheet')].reverse().find(visible);
          const scope = sheet || document;
          const selectors = sheet ? '.ulemi-native-compose textarea, .rich-workspace-request textarea, .complete-app-edit textarea' : '.liveui-composer textarea';
          const input = [...scope.querySelectorAll(selectors)].find(node => visible(node) && !node.disabled && !node.readOnly);
          if (!input) return {ok:false, requestID, message:'Open the instruction field in your current app, then try again.'};
          const old = input.value;
          const next = old + (old ? '\\n\\n' : '') + text;
          if (input.maxLength >= 0 && next.length > input.maxLength) return {ok:false, requestID, message:'Your draft is too long for these observations. Shorten it and try again.'};
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, next);
          input.dispatchEvent(new Event('input', {bubbles:true}));
          receipts[requestID] = {pending:true, requestID};
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (!input.isConnected || input.value !== next) { receipts[requestID] = {ok:false, requestID, message:'The instruction field changed before it accepted the observations. Please try again.'}; return; }
            const receipt = {ok:true, requestID, appendedCharacters:text.length, draftCharacters:next.length};
            receipts[requestID] = receipt;
            const keys = Object.keys(receipts); if (keys.length > 50) delete receipts[keys[0]];
          }));
          return receipts[requestID];
        })();
        """
    }
}
