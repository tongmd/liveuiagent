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
                DisclosureGroup("手机模型", isExpanded: $showModels) {
                    VStack(alignment: .leading, spacing: 12) {
                        Picker("模型", selection: Binding(get: { chat.selectedID }, set: chat.select)) {
                            ForEach(LocalModel.all) { model in Text("\(model.title) · \(model.sizeLabel)").tag(model.id) }
                        }.disabled(chat.busy || chat.downloading)
                        Text("E4B 更注重回答质量，E2B 占用更少。模型保存在手机，离线对话不会发送到服务器。")
                            .font(.callout).foregroundStyle(.secondary)
                        if chat.downloading {
                            ProgressView(value: chat.progress)
                            Button("暂停下载") { chat.pauseDownload() }
                        } else if chat.installed {
                            HStack {
                                if !chat.ready { Button("载入模型") { chat.load() }.disabled(chat.busy) }
                                Button("删除模型", role: .destructive) { confirmDelete = true }.disabled(chat.busy)
                            }
                        } else {
                            Toggle("允许蜂窝网络下载", isOn: $chat.cellular)
                            Button("下载并配置 \(chat.model.sizeLabel)") { chat.download() }.disabled(chat.busy)
                            Button("清除未完成下载", role: .destructive) { chat.removeDownload() }.disabled(chat.busy)
                        }
                        Link("Google 官方模型与下载说明", destination: URL(string: "https://developers.google.com/edge/litert-lm/models/gemma-4")!)
                        Link("查看本次下载来源", destination: chat.model.source)
                    }.padding(.vertical, 10)
                }.padding(16)
                if !chat.state.isEmpty { Text(chat.state).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 16).padding(.bottom, 8) }
                if let error = chat.error { Text(error).font(.callout).foregroundStyle(.red).padding(.horizontal, 16).padding(.bottom, 8).accessibilityIdentifier("local-error") }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            if chat.messages.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text("不登录，也能开始对话。多次对话会保存在这台手机上。")
                                    Text("下载完成后，断网仍可使用。云端应用继续在原工作区使用。")
                                }.foregroundStyle(.secondary).padding(.top, 20)
                            }
                            ForEach(chat.messages) { item in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(item.role == "user" ? "你" : "Ulemi").font(.caption).foregroundStyle(.secondary)
                                    Text(item.text.isEmpty ? (chat.busy ? "正在思考…" : "未完成") : item.text).textSelection(.enabled)
                                }.frame(maxWidth: .infinity, alignment: .leading).id(item.id)
                            }
                        }.padding(16)
                    }
                    .onChange(of: chat.messages.count) { _ in if let id = chat.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                }
                HStack(alignment: .bottom) {
                    TextField("和手机模型聊聊", text: $input, axis: .vertical).lineLimit(1...5)
                        .padding(12).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
                    if chat.busy { Button("停止") { chat.stop() }.frame(minWidth: 48, minHeight: 44) }
                    else {
                        Button("发送") { let text = input; chat.send(text); if chat.busy { input = "" } }
                            .disabled(!chat.ready || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .frame(minWidth: 48, minHeight: 44)
                    }
                }.padding(12)
            }
            .navigationTitle("本机对话").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("返回") { chat.stop(); chat.pauseDownload(); dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) { Button("新对话") { chat.clearChat() }.disabled(chat.busy) }
            }
            .confirmationDialog("删除手机里的模型文件？", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除模型", role: .destructive) { chat.removeDownload() }
            } message: { Text("对话保留，之后可以重新下载。") }
            .onChange(of: scenePhase) { phase in if phase != .active { chat.unload(); chat.pauseDownload() } }
            .onDisappear { chat.stop(); chat.pauseDownload(); chat.unload() }
        }
    }
}
