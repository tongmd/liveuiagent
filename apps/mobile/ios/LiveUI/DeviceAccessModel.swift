import Foundation
import Combine
import CoreBluetooth
import CoreMotion
import CoreLocation
import Network

struct DiscoveredDevice: Identifiable {
    let id: String
    let name: String
    let detail: String
    var metadata: [String: String] = [:]
}

// All hardware is foreground-only, explicit and native. No data is injected into
// web pages unless the user explicitly adds an observation snapshot to the
// current instruction. No device commands are sent.
final class DeviceAccessModel: NSObject, ObservableObject, CBCentralManagerDelegate, CLLocationManagerDelegate {
    @Published private(set) var bluetoothStatus = "Find nearby Bluetooth LE devices."
    @Published private(set) var networkStatus = "Find HTTP and MQTT services on your Wi-Fi network."
    @Published private(set) var sensorStatus = "Read live motion sensors on this phone."
    @Published private(set) var locationStatus = "Request one current location."
    @Published private(set) var bluetoothDevices: [DiscoveredDevice] = []
    @Published private(set) var networkDevices: [DiscoveredDevice] = []
    @Published private(set) var sensorReadings: [String: String] = [:]
    @Published private(set) var scanningBluetooth = false
    @Published private(set) var scanningNetwork = false
    @Published private(set) var readingSensors = false
    @Published private(set) var locating = false
    @Published private(set) var observations: [String: DeviceObservation] = [:]

    func record(_ observation: DeviceObservation) {
        guard observation.values.values.allSatisfy({ $0.isFinite }) else {
            sensorStatus = "A sensor returned an invalid reading. Start readings again."
            return
        }
        observations[observation.id] = observation
    }
    func snapshot() -> DeviceObservationEnvelope {
        DeviceObservationEnvelope(createdAt: Date(), observations: Array(observations.values), availability: ["Bluetooth": bluetoothStatus, "Local network": networkStatus, "Sensors": sensorStatus, "Location": locationStatus])
    }
    private func clearObservations(_ prefix: String) { observations = observations.filter { !$0.key.hasPrefix(prefix) } }

    private var central: CBCentralManager?
    private var browsers: [NWBrowser] = []
    private let motion = CMMotionManager()
    private let altimeter = CMAltimeter()
    private var locationManager: CLLocationManager?
    private var bluetoothSession = DeviceAccessSession()
    private var networkSession = DeviceAccessSession()
    private var sensorSession = DeviceAccessSession()
    private var locationSession = DeviceAccessSession()
    private var locationRequestStarted = false
    private var timeouts: [String: DispatchWorkItem] = [:]
    private var networkResults: [String: [DiscoveredDevice]] = [:]

    private func timeout(_ name: String, seconds: Double, action: @escaping () -> Void) {
        timeouts.removeValue(forKey: name)?.cancel()
        let work = DispatchWorkItem(block: action)
        timeouts[name] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
    private func cancelTimeout(_ name: String) { timeouts.removeValue(forKey: name)?.cancel() }

    func startBluetooth() {
        stopBluetooth()
        bluetoothDevices = []; clearObservations("ble:")
        scanningBluetooth = true
        let ticket = bluetoothSession.begin()
        bluetoothStatus = "Waiting for Bluetooth…"
        timeout("bluetooth", seconds: DeviceAccessPolicy.discoverySeconds) { [weak self] in
            guard let self, self.bluetoothSession.accepts(ticket) else { return }
            self.stopBluetooth(message: "Scan finished. Tap Scan to search again.")
        }
        // Use a new delegate identity for each scan, preventing queued callbacks
        // from an earlier scan from appearing in a later one.
        central = CBCentralManager(delegate: self, queue: .main)
    }
    func stopBluetooth(message: String = "Bluetooth scan stopped.") {
        bluetoothSession.stop(); cancelTimeout("bluetooth")
        central?.stopScan(); central?.delegate = nil; central = nil; scanningBluetooth = false
        bluetoothStatus = message
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central === self.central, scanningBluetooth, bluetoothSession.id != nil else { return }
        switch central.state {
        case .poweredOn:
            bluetoothStatus = "Scanning for nearby devices…"
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        case .unauthorized: stopBluetooth(message: "Bluetooth access is denied. Enable it in Settings.")
        case .poweredOff: stopBluetooth(message: "Bluetooth is off. Turn it on in Settings, then scan again.")
        case .unsupported: stopBluetooth(message: "Bluetooth LE is unavailable on this device.")
        case .resetting, .unknown: bluetoothStatus = "Waiting for Bluetooth…"
        @unknown default: stopBluetooth(message: "Bluetooth is unavailable.")
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard central === self.central, scanningBluetooth, bluetoothSession.id != nil else { return }
        let id = peripheral.identifier.uuidString
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name ?? "Unnamed device"
        let signal = RSSI.intValue == 127 ? "Signal unavailable" : "\(RSSI.intValue) dBm"
        let item = DiscoveredDevice(id: id, name: name, detail: "Bluetooth LE · \(signal)")
        if let index = bluetoothDevices.firstIndex(where: { $0.id == id }) { bluetoothDevices[index] = item }
        else if bluetoothDevices.count < DeviceAccessPolicy.maximumResults { bluetoothDevices.append(item) }
        if bluetoothDevices.contains(where: { $0.id == id }) {
            record(DeviceObservation(id: "ble:" + id, source: "CoreBluetooth advertisement", capturedAt: Date(),
                values: RSSI.intValue == 127 ? [:] : ["signal": RSSI.doubleValue], units: ["signal": "dBm"],
                details: ["name": name, "peripheralID": id, "transport": "Bluetooth LE", "serviceUUIDs": (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map { $0.uuidString }.joined(separator: ", "), "signalStatus": RSSI.intValue == 127 ? "unavailable" : "observed"]))
        }
    }

    func startNetwork() {
        stopNetwork()
        let ticket = networkSession.begin()
        networkDevices = []; networkResults = [:]; clearObservations("bonjour:"); scanningNetwork = true
        networkStatus = "Searching your local network…"
        for type in DeviceAccessPolicy.bonjourTypes {
            let browser = NWBrowser(for: .bonjour(type: type, domain: "local."), using: .tcp)
            browser.stateUpdateHandler = { [weak self] state in
                guard let self, self.networkSession.accepts(ticket) else { return }
                switch state {
                case .waiting(let error), .failed(let error):
                    self.stopNetwork(message: "Discovery unavailable: \(error.localizedDescription). Check Local Network access in Settings and your Wi-Fi connection.")
                default: break
                }
            }
            browser.browseResultsChangedHandler = { [weak self] results, _ in
                guard let self, self.networkSession.accepts(ticket) else { return }
                self.networkResults[type] = results.compactMap { result in
                    guard case let .service(name, serviceType, domain, _) = result.endpoint else { return nil }
                    return DiscoveredDevice(id: DeviceAccessPolicy.resultKey(name: name, type: serviceType, domain: domain),
                                            name: name, detail: "\(serviceType) · \(domain)", metadata: ["name":name,"serviceType":serviceType,"domain":domain])
                }.sorted { $0.id < $1.id }
                self.networkDevices = Array(self.networkResults.values.flatMap { $0 }.sorted { $0.id < $1.id }.prefix(DeviceAccessPolicy.maximumResults))
                self.clearObservations("bonjour:")
                for device in self.networkDevices {
                    self.record(DeviceObservation(id: "bonjour:" + device.id, source: "Bonjour service advertisement", capturedAt: Date(),
                        values: [:], units: [:], details: device.metadata))
                }
            }
            browsers.append(browser); browser.start(queue: .main)
        }
        timeout("network", seconds: DeviceAccessPolicy.discoverySeconds) { [weak self] in
            guard let self, self.networkSession.accepts(ticket) else { return }
            self.stopNetwork(message: "Search finished. Only devices advertising HTTP or MQTT appear here.")
        }
    }
    func stopNetwork(message: String = "Local network search stopped.") {
        networkSession.stop(); cancelTimeout("network")
        browsers.forEach { $0.cancel() }; browsers.removeAll()
        scanningNetwork = false; networkStatus = message
    }

    func startSensors() {
        stopSensors()
        let ticket = sensorSession.begin()
        readingSensors = true
        sensorStatus = "Live readings · stops automatically after 60 seconds."
        sensorReadings = [:]; clearObservations("sensor:")
        motion.accelerometerUpdateInterval = 0.25
        motion.gyroUpdateInterval = 0.25
        motion.magnetometerUpdateInterval = 0.25
        func vector(_ x: Double, _ y: Double, _ z: Double, _ unit: String) -> String {
            String(format: "x %.2f  y %.2f  z %.2f %@", x, y, z, unit)
        }
        sensorReadings["Acceleration"] = motion.isAccelerometerAvailable ? "Waiting…" : "Unavailable on this device"
        if motion.isAccelerometerAvailable {
            motion.startAccelerometerUpdates(to: .main) { [weak self] data, error in
                guard let self, self.sensorSession.accepts(ticket) else { return }
                if let data {
                    self.sensorReadings["Acceleration"] = vector(data.acceleration.x, data.acceleration.y, data.acceleration.z, "g")
                    self.record(DeviceObservation(id: "sensor:acceleration", source: "CoreMotion accelerometer", capturedAt: Date(), values: ["x":data.acceleration.x,"y":data.acceleration.y,"z":data.acceleration.z], units: ["x":"g","y":"g","z":"g"], details: [:]))
                }
                else if error != nil { self.sensorReadings["Acceleration"] = "Reading unavailable" }
            }
        }
        sensorReadings["Rotation"] = motion.isGyroAvailable ? "Waiting…" : "Unavailable on this device"
        if motion.isGyroAvailable {
            motion.startGyroUpdates(to: .main) { [weak self] data, error in
                guard let self, self.sensorSession.accepts(ticket) else { return }
                if let data {
                    self.sensorReadings["Rotation"] = vector(data.rotationRate.x, data.rotationRate.y, data.rotationRate.z, "rad/s")
                    self.record(DeviceObservation(id: "sensor:rotation", source: "CoreMotion gyroscope", capturedAt: Date(), values: ["x":data.rotationRate.x,"y":data.rotationRate.y,"z":data.rotationRate.z], units: ["x":"rad/s","y":"rad/s","z":"rad/s"], details: [:]))
                }
                else if error != nil { self.sensorReadings["Rotation"] = "Reading unavailable" }
            }
        }
        sensorReadings["Magnetic field"] = motion.isMagnetometerAvailable ? "Waiting…" : "Unavailable on this device"
        if motion.isMagnetometerAvailable {
            motion.startMagnetometerUpdates(to: .main) { [weak self] data, error in
                guard let self, self.sensorSession.accepts(ticket) else { return }
                if let data {
                    self.sensorReadings["Magnetic field"] = vector(data.magneticField.x, data.magneticField.y, data.magneticField.z, "µT")
                    self.record(DeviceObservation(id: "sensor:magnetic", source: "CoreMotion magnetometer", capturedAt: Date(), values: ["x":data.magneticField.x,"y":data.magneticField.y,"z":data.magneticField.z], units: ["x":"µT","y":"µT","z":"µT"], details: [:]))
                }
                else if error != nil { self.sensorReadings["Magnetic field"] = "Reading unavailable" }
            }
        }
        sensorReadings["Pressure / altitude"] = CMAltimeter.isRelativeAltitudeAvailable() ? "Waiting…" : "Unavailable on this device"
        if CMAltimeter.isRelativeAltitudeAvailable() {
            if CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted {
                sensorReadings["Pressure / altitude"] = "Motion access denied. Check Settings."
            } else {
                altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, error in
                    guard let self, self.sensorSession.accepts(ticket) else { return }
                    if let data {
                        self.record(DeviceObservation(id: "sensor:altimeter", source: "CoreMotion altimeter", capturedAt: Date(), values: ["pressure":data.pressure.doubleValue,"relativeAltitude":data.relativeAltitude.doubleValue], units: ["pressure":"kPa","relativeAltitude":"m"], details: [:]))
                        self.sensorReadings["Pressure / altitude"] = String(format: "%.2f kPa · %+.2f m relative", data.pressure.doubleValue, data.relativeAltitude.doubleValue)
                    } else if error != nil { self.sensorReadings["Pressure / altitude"] = "Reading unavailable. Check Motion access in Settings." }
                }
            }
        }
        timeout("sensors", seconds: DeviceAccessPolicy.sensorSeconds) { [weak self] in
            guard let self, self.sensorSession.accepts(ticket) else { return }
            self.stopSensors(message: "Readings paused. Tap Start to read again.")
        }
    }
    func stopSensors(message: String = "Sensor readings stopped.") {
        sensorSession.stop(); cancelTimeout("sensors")
        motion.stopAccelerometerUpdates(); motion.stopGyroUpdates(); motion.stopMagnetometerUpdates()
        altimeter.stopRelativeAltitudeUpdates(); readingSensors = false; sensorStatus = message
    }

    func requestLocation() {
        stopLocation(); clearObservations("location:")
        guard CLLocationManager.locationServicesEnabled() else { locationStatus = "Location Services are off. Enable them in Settings."; return }
        let ticket = locationSession.begin(); locating = true
        locationStatus = "Waiting for a current location…"
        locationManager = CLLocationManager(); locationManager?.delegate = self
        locationManager?.desiredAccuracy = kCLLocationAccuracyHundredMeters
        timeout("location", seconds: DeviceAccessPolicy.locationSeconds) { [weak self] in
            guard let self, self.locationSession.accepts(ticket) else { return }
            self.stopLocation(message: "No current location received. You can try again.")
        }
        continueLocation()
    }
    private func continueLocation() {
        guard locating, let manager = locationManager else { return }
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            guard !locationRequestStarted else { return }
            locationRequestStarted = true; manager.requestLocation()
        case .denied, .restricted: stopLocation(message: "Location access is denied. Enable While Using the App in Settings.")
        @unknown default: stopLocation(message: "Location access is unavailable.")
        }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager === locationManager else { return }; continueLocation()
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard manager === locationManager, locating, locationSession.id != nil, let location = locations.last,
              DeviceAccessPolicy.acceptsLocation(timestamp: location.timestamp, accuracy: location.horizontalAccuracy) else { return }
        record(DeviceObservation(id: "location:fix", source: "CoreLocation current fix", capturedAt: location.timestamp,
            values: ["latitude":location.coordinate.latitude,"longitude":location.coordinate.longitude,"horizontalAccuracy":location.horizontalAccuracy],
            units: ["latitude":"degrees","longitude":"degrees","horizontalAccuracy":"m"], details: [:]))
        stopLocation(message: String(format: "%.5f, %.5f · ±%.0f m", location.coordinate.latitude, location.coordinate.longitude, location.horizontalAccuracy))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard manager === locationManager, locating else { return }
        stopLocation(message: "Location unavailable. Check access in Settings and try again.")
    }
    func stopLocation(message: String = "Location request stopped.") {
        locationSession.stop(); cancelTimeout("location")
        locationManager?.stopUpdatingLocation(); locationManager?.delegate = nil; locationManager = nil
        locationRequestStarted = false; locating = false; locationStatus = message
    }
    func stopAll() {
        stopBluetooth(); stopNetwork(); stopSensors(); stopLocation()
        // Do not retain nearby identifiers or location after leaving this screen.
        bluetoothDevices = []; networkDevices = []; networkResults = [:]; sensorReadings = [:]; observations = [:]
    }
}
