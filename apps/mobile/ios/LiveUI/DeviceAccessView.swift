import SwiftUI

struct DeviceAccessView: View {
    @StateObject private var model = DeviceAccessModel()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("Explore the devices around you and the sensors in your phone.")
                        .font(.body).foregroundStyle(.secondary)
                    card("Bluetooth", icon: "antenna.radiowaves.left.and.right") {
                        status(model.bluetoothStatus)
                        control(model.scanningBluetooth ? "Stop scan" : "Scan for devices", active: model.scanningBluetooth) {
                            if model.scanningBluetooth { model.stopBluetooth() } else { model.startBluetooth() }
                        }
                        devices(model.bluetoothDevices)
                    }
                    card("Local network", icon: "wifi") {
                        status(model.networkStatus)
                        control(model.scanningNetwork ? "Stop search" : "Find devices", active: model.scanningNetwork) {
                            if model.scanningNetwork { model.stopNetwork() } else { model.startNetwork() }
                        }
                        devices(model.networkDevices)
                    }
                    card("Motion & environment", icon: "gyroscope") {
                        status(model.sensorStatus)
                        control(model.readingSensors ? "Stop readings" : "Start readings", active: model.readingSensors) {
                            if model.readingSensors { model.stopSensors() } else { model.startSensors() }
                        }
                        ForEach(model.sensorReadings.keys.sorted(), id: \.self) { name in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(name).font(.subheadline.weight(.medium))
                                Text(model.sensorReadings[name] ?? "").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    card("Location", icon: "location") {
                        status(model.locationStatus)
                        control(model.locating ? "Cancel request" : "Get current location", active: model.locating) {
                            if model.locating { model.stopLocation() } else { model.requestLocation() }
                        }
                    }
                    Text("Discovery does not connect to or control a device. Robot control needs a device-specific connection, authorization and emergency stop. Readings stay on this screen and stop when you leave or put Ulemi in the background.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Button {
                        model.stopAll()
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    } label: {
                        Label("Manage permissions in Settings", systemImage: "gearshape").frame(maxWidth: .infinity, minHeight: 44)
                    }.buttonStyle(.plain).font(.subheadline.weight(.medium))
                }.padding(20).frame(maxWidth: 620).frame(maxWidth: .infinity)
            }
            .background(Color(red: 0.97, green: 0.97, blue: 0.96))
            .navigationTitle("Devices & sensors")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { model.stopAll(); dismiss() } } }
        }
        .tint(.primary)
        .onDisappear { model.stopAll() }
        // Permission sheets temporarily make the scene inactive. Keep the user's
        // pending request for that transition, but never run in the background.
        .onChange(of: scenePhase) { phase in if phase == .background { model.stopAll() } }
    }
    private func status(_ value: String) -> some View {
        Text(value).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    private func card<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(title, systemImage: icon).font(.headline)
            content()
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white, in: RoundedRectangle(cornerRadius: 20))
    }
    private func control(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer()
                Image(systemName: active ? "stop.fill" : "arrow.right")
            }.font(.subheadline.weight(.semibold)).padding(.horizontal, 16).frame(minHeight: 48)
                .foregroundStyle(active ? Color.primary : .white)
                .background(active ? Color.black.opacity(0.06) : Color.black, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain)
    }
    @ViewBuilder private func devices(_ entries: [DiscoveredDevice]) -> some View {
        ForEach(entries) { item in
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name).font(.subheadline.weight(.medium))
                Text(item.detail).font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
