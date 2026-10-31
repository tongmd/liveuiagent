import SwiftUI
import WebKit

typealias DeviceWorkspaceSink = (DeviceObservationEnvelope, @escaping (Result<Void, Error>) -> Void) -> Void

struct DeviceAccessView: View {
    var workspaceSink: DeviceWorkspaceSink? = nil
    @State private var boundSink: DeviceWorkspaceSink?
    @State private var bound = false
    @State private var transferring = false
    @State private var transferMessage: String?
    @State private var pendingTransfer: DeviceObservationEnvelope?
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
                            pendingTransfer = nil; transferMessage = nil
                            if model.scanningBluetooth { model.stopBluetooth() } else { model.startBluetooth() }
                        }
                        devices(model.bluetoothDevices)
                    }
                    card("Local network", icon: "wifi") {
                        status(model.networkStatus)
                        control(model.scanningNetwork ? "Stop search" : "Find devices", active: model.scanningNetwork) {
                            pendingTransfer = nil; transferMessage = nil
                            if model.scanningNetwork { model.stopNetwork() } else { model.startNetwork() }
                        }
                        devices(model.networkDevices)
                    }
                    card("Motion & environment", icon: "gyroscope") {
                        status(model.sensorStatus)
                        control(model.readingSensors ? "Stop readings" : "Start readings", active: model.readingSensors) {
                            pendingTransfer = nil; transferMessage = nil
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
                            pendingTransfer = nil; transferMessage = nil
                            if model.locating { model.stopLocation() } else { model.requestLocation() }
                        }
                    }
                    if boundSink != nil {
                        Button {
                            guard !transferring, pendingTransfer != nil || !model.observations.isEmpty, let sink = boundSink else { return }
                            transferring = true; transferMessage = nil
                            let snapshot = pendingTransfer ?? model.snapshot(); pendingTransfer = snapshot
                            sink(snapshot) { result in
                                transferring = false
                                switch result {
                                case .success: model.stopAll(); dismiss()
                                case .failure(let error): transferMessage = error.localizedDescription
                                }
                            }
                        } label: {
                            Label(transferring ? "Adding observations…" : (pendingTransfer == nil ? "Use in workspace" : "Retry adding observations"), systemImage: "arrow.up.doc")
                                .font(.headline).frame(maxWidth: .infinity, minHeight: 48)
                        }.buttonStyle(.borderedProminent).tint(.black)
                            .disabled((pendingTransfer == nil && model.observations.isEmpty) || transferring)
                        if let transferMessage { status(transferMessage) }
                        Text("Adds the latest observed values, sources, times and units to your current instruction. Your draft stays intact; you choose when to send.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("Readings stop when you leave.")
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
        .onAppear { if !bound { boundSink = workspaceSink; bound = true } }
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


@MainActor
extension BrowserModel {
    // Capture both account and WKWebView identity at presentation. A changed
    // login or recreated browser cannot receive the previous screen's readings.
    func deviceWorkspaceSink() -> DeviceWorkspaceSink? {
        guard authenticated, workspaceReady, let expected = connection, let target = webView else { return nil }
        return { [weak self, weak target] envelope, completion in
            guard let self, let target, self.connection == expected, self.webView === target,
                  self.authenticated, self.workspaceReady, let url = target.url, expected.contains(url) else {
                completion(.failure(NSError(domain: "UlemiDevices", code: 1, userInfo: [NSLocalizedDescriptionKey: "Your workspace changed. Reopen Devices & sensors from the current account."])))
                return
            }
            DeviceWorkspaceScriptRunner.run(text: envelope.readableText(), requestID: envelope.transferID, in: target) { [weak self, weak target] result in
                    guard let self, let target, self.connection == expected, self.webView === target else {
                        completion(.failure(NSError(domain: "UlemiDevices", code: 2, userInfo: [NSLocalizedDescriptionKey: "Your workspace changed before the observations were accepted."])))
                        return
                    }
                    switch result {
                    case .success(let value):
                        if let receipt = value as? [String: Any], receipt["ok"] as? Bool == true, receipt["requestID"] as? String == envelope.transferID.uuidString { completion(.success(())) }
                        else {
                            let message = (value as? [String: Any])?["message"] as? String ?? "The instruction field did not accept the observations. Please try again."
                            completion(.failure(NSError(domain: "UlemiDevices", code: 3, userInfo: [NSLocalizedDescriptionKey: message])))
                        }
                    case .failure:
                        completion(.failure(NSError(domain: "UlemiDevices", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not reach the current instruction field. Open it and try again."])))
                    }
            }
        }
    }
}


@MainActor
enum DeviceWorkspaceScriptRunner {
    // evaluateJavaScript uses WebKit's Objective-C callback API already used by
    // the app. callAsyncJavaScript's Swift Result overlay adds a libswiftWebKit
    // dependency absent from the iOS 18.5 simulator runtime in Xcode 16.4.
    // We retain the same two-frame DOM acknowledgement through a receipt query.
    static func run(text: String, requestID: UUID, in webView: WKWebView,
                    completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            let script = try DeviceWorkspaceTransfer.script(text: text, requestID: requestID)
            evaluate(script, requestID: requestID, in: webView, remaining: 100, completion: completion)
        } catch { completion(.failure(error)) }
    }
    private static func evaluate(_ script: String, requestID: UUID, in webView: WKWebView,
                                 remaining: Int, completion: @escaping (Result<Any, Error>) -> Void) {
        webView.evaluateJavaScript(script) { [weak webView] value, error in
            if let error { completion(.failure(error)); return }
            guard let receipt = value as? [String: Any], receipt["requestID"] as? String == requestID.uuidString else {
                completion(.failure(NSError(domain: "UlemiDevices", code: 5, userInfo: [NSLocalizedDescriptionKey: "The workspace did not return an observation receipt."])))
                return
            }
            guard receipt["pending"] as? Bool == true else { completion(.success(receipt)); return }
            guard remaining > 0 else {
                completion(.failure(NSError(domain: "UlemiDevices", code: 6, userInfo: [NSLocalizedDescriptionKey: "The workspace has not confirmed the observations yet. Return to Ulemi and retry."])))
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak webView] in
                guard let webView else {
                    completion(.failure(NSError(domain: "UlemiDevices", code: 7, userInfo: [NSLocalizedDescriptionKey: "The workspace closed before it confirmed the observations."])))
                    return
                }
                // A UUID is generated natively; this query only reads the original
                // receipt. It never replays input events or appends text again.
                let query = "window.__ulemiDeviceObservationReceipts?.['\(requestID.uuidString)'] || null"
                evaluate(query, requestID: requestID, in: webView, remaining: remaining - 1, completion: completion)
            }
        }
    }
}
