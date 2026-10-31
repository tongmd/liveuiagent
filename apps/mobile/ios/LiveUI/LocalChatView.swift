import SwiftUI

struct LocalChatView: View {
    @StateObject private var chat = LocalChat()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var input = ""
    @State private var confirmDelete = false
    @State private var showModels = true
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            modelControls
                            if chat.messages.isEmpty {
                                VStack(alignment: .leading, spacing: 14) {
                                    BrandMark(size: 34).padding(.bottom, 10)
                                    Text("Space to think.").font(.system(size: 28, weight: .semibold)).foregroundStyle(AppStyle.ink)
                                    Text("No account needed.")
                                    Text("Download a model once, then chat offline. Your conversations stay on this iPhone.")
                                }.foregroundStyle(.secondary).padding(.vertical, 24)
                            }
                            ForEach(chat.messages) { item in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(item.role == "user" ? "You" : "Ulemi").font(.caption).foregroundStyle(.secondary)
                                    Text(item.text.isEmpty ? (chat.busy ? "Thinking…" : "Incomplete") : item.text).textSelection(.enabled)
                                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(item.role == "user" ? Color.white : Color.clear, in: RoundedRectangle(cornerRadius: 20)).id(item.id)
                            }
                        }.padding(16)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: chat.messages.count) { _ in if let id = chat.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                }
                HStack(alignment: .bottom) {
                    TextField("Ask anything…", text: $input, axis: .vertical).lineLimit(1...5)
                        .padding(12).background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                    if chat.busy { Button { chat.stop() } label: { Image(systemName: "stop.fill").frame(width: 46, height: 46) }.foregroundStyle(.white).background(AppStyle.ink, in: Circle()).accessibilityLabel("Stop generation") }
                    else {
                        Button { let text = input; chat.send(text); if chat.busy { input = "" } } label: {
                            Image(systemName: "arrow.up").font(.system(size: 18, weight: .semibold)).frame(width: 46, height: 46)
                        }.foregroundStyle(.white).background(AppStyle.ink.opacity(chat.ready && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 1 : 0.25), in: Circle())
                            .disabled(!chat.ready || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityLabel("Send")
                    }
                }.padding(16).background(AppStyle.background)
            }.background(AppStyle.background).tint(AppStyle.ink)
            .navigationTitle("On-device chat").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("Back") { chat.stop(); chat.pauseDownload(); dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) { Button("New chat") { chat.clearChat() }.disabled(chat.busy) }
            }
            .confirmationDialog("Remove this model?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Remove model", role: .destructive) { chat.removeDownload() }
            } message: { Text("Your conversations will stay. You can download the model again.") }
            .onChange(of: scenePhase) { phase in if phase != .active { chat.unload(); chat.pauseDownload() } }
            .onDisappear { chat.stop(); chat.pauseDownload(); chat.unload() }
        }.tint(AppStyle.ink)
    }
    private var modelControls: some View {
        VStack(alignment: .leading, spacing: 0) {
                DisclosureGroup("On-device model", isExpanded: $showModels) {
                    VStack(alignment: .leading, spacing: 12) {
                        Picker("Model", selection: Binding(get: { chat.selectedID }, set: chat.select)) {
                            ForEach(LocalModel.all) { model in Text("\(model.title) · \(model.sizeLabel)").tag(model.id) }
                        }.disabled(chat.busy || chat.downloading)
                        Text("E4B offers more capacity. E2B uses less memory. Chats run on your iPhone and are not sent to a server.")
                            .font(.callout).foregroundStyle(.secondary)
                        if chat.downloading {
                            ProgressView(value: chat.progress)
                            Button("Pause download") { chat.pauseDownload() }.buttonStyle(SecondaryButtonStyle())
                        } else if chat.installed {
                            HStack {
                                if !chat.ready { Button("Load model") { chat.load() }.buttonStyle(SecondaryButtonStyle()).disabled(chat.busy) }
                                Button("Remove model", role: .destructive) { confirmDelete = true }.disabled(chat.busy)
                            }
                        } else {
                            Toggle("Use cellular data", isOn: $chat.cellular)
                            Button("Download \(chat.model.sizeLabel)") { chat.download() }.buttonStyle(PrimaryButtonStyle()).disabled(chat.busy)
                            Button("Clear unfinished download", role: .destructive) { chat.removeDownload() }.disabled(chat.busy)
                        }
                        Link("Model information", destination: URL(string: "https://developers.google.com/edge/litert-lm/models/gemma-4")!)
                        Link("Download source", destination: chat.model.source)
                    }.padding(.vertical, 10)
                }.padding(16)
                if !chat.state.isEmpty { Text(chat.state).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.bottom, 8) }
                if let error = chat.error { Text(error).font(.callout).foregroundStyle(.red).padding(.horizontal, 16).padding(.bottom, 8).accessibilityIdentifier("local-error") }
        }.padding(.vertical, 4).background(.white, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(AppStyle.ink.opacity(0.06), lineWidth: 1))
    }

}
