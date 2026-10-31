import Foundation
import SwiftUI
import LiteRTLM

struct LocalChatMessage: Identifiable, Codable {
    var id = UUID()
    let role: String
    var text: String
    var complete: Bool = false
}

@MainActor
final class LocalChat: ObservableObject {
    @Published var selectedID: String
    @Published var state = ""
    @Published var progress = 0.0
    @Published var downloading = false
    @Published var busy = false
    @Published var ready = false
    @Published var messages: [LocalChatMessage] = []
    @Published var error: String?
    @Published var cellular = false
    private var downloader: ModelDownload?
    private var request: Task<Void, Never>?
    private var engine: Engine?
    private var conversation: Conversation?
    private var generation = UUID()
    private var autoLoad = true
    private var pendingUnload = false
    private var storageReadable = true
    let directory: URL
    var model: LocalModel { LocalModel.all.first { $0.id == selectedID } ?? .e2b }
    var file: URL { directory.appendingPathComponent(model.filename) }
    var installed: Bool { (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) == Int(model.bytes) }

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("LocalModels", isDirectory: true)
        self.selectedID = UserDefaults.standard.string(forKey: "ulemi.local.model") ?? LocalModel.recommended(memory: ProcessInfo.processInfo.physicalMemory).id
        do {
            try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
            var location = self.directory
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try location.setResourceValues(values)
            let chat = self.directory.appendingPathComponent("chat.json")
            if let data = try? Data(contentsOf: chat) { messages = try JSONDecoder().decode([LocalChatMessage].self, from: data) }
        } catch { self.storageReadable = false; self.error = "无法读取本机保存的对话。原文件未覆盖。" }
    }
    func select(_ id: String) {
        guard !downloading, !busy else { return }
        unload(); selectedID = id; UserDefaults.standard.set(id, forKey: "ulemi.local.model"); state = ""; error = nil
    }
    func download() {
        guard !downloading, !busy else { return }
        do {
            let capacity = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
            guard capacity >= model.bytes + 1_073_741_824 else { throw LocalModelError.message("空间不足，请先留出至少 \(model.sizeLabel) 加 1 GB 可用空间。") }
            guard ProcessInfo.processInfo.physicalMemory >= model.minimumRAM else { throw LocalModelError.message("此设备内存不足，请选择较小的 E2B。") }
            autoLoad = true; error = nil; downloading = true; progress = 0; state = "正在下载，完成后自动配置…"
            let ticket = UUID(); generation = ticket
            let transfer = ModelDownload(model: model, destination: file, cellular: cellular, progress: { [weak self] value in
                Task { @MainActor in guard let self, self.generation == ticket else { return }; self.progress = value }
            }, completion: { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == ticket else { return }
                    self.downloading = false; self.downloader = nil
                    switch result {
                    case .success: self.progress = 1; if self.autoLoad { self.load() }
                    case .failure(let error): self.error = error.localizedDescription; self.state = ""
                    }
                }
            })
            downloader = transfer; transfer.start()
        } catch { self.error = error.localizedDescription }
    }
    func pauseDownload() { autoLoad = false; downloader?.pause() }
    func removeDownload() {
        guard !downloading, !busy else { return }
        unload()
        do {
            for url in [file, file.appendingPathExtension("resume")] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            state = "模型已删除，对话仍保留。"; error = nil
        } catch { self.error = "未能删除模型，请重试。" }
    }
    func load() {
        guard !busy, !downloading else { return }
        #if targetEnvironment(simulator)
        error = "模拟器不运行手机模型。请在 iPhone 16 或更新机型上使用。"
        return
        #else
        guard ProcessInfo.processInfo.physicalMemory >= model.minimumRAM else { error = "内存不足，请选择 E2B。"; return }
        pendingUnload = false; busy = true; ready = false; error = nil; state = "正在检查和载入模型…"
        let selected = model; let location = file
        request = Task {
            do {
                try await Task.detached(priority: .userInitiated) { try LocalModel.verify(location, bytes: selected.bytes, sha256: selected.sha256) }.value
                try Task.checkCancellation()
                let cache = directory.appendingPathComponent("cache", isDirectory: true)
                try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
                // E4B/E2B use a bounded context; no vision/audio executors are loaded for text chat.
                var instance = Engine(engineConfig: try EngineConfig(modelPath: location.path, backend: .gpu, maxNumTokens: 4096, cacheDir: cache.path))
                var backend = "Metal"
                do { try await instance.initialize() }
                catch {
                    try Task.checkCancellation()
                    instance = Engine(engineConfig: try EngineConfig(modelPath: location.path, backend: .cpu(threadCount: 4), maxNumTokens: 4096, cacheDir: cache.path))
                    try await instance.initialize(); backend = "CPU"
                }
                try Task.checkCancellation()
                engine = instance; ready = true; state = "\(selected.title) · \(backend) · 离线可用"
            } catch { self.error = error.localizedDescription; engine = nil; state = "" }
            busy = false; request = nil
            if pendingUnload { unload() }
        }
        #endif
    }
    func send(_ input: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ready, !busy, let engine, !text.isEmpty else { return }
        guard text.utf8.count <= 1200 else { error = "请把这条消息缩短到 约 400 个汉字以内。"; return }
        busy = true; error = nil
        var history: [Message] = []; var count = 0
        // Only replay complete successful turns. A cancelled/failed answer is never model history.
        if messages.count >= 2 {
            for index in stride(from: messages.count - 2, through: 0, by: -2) {
                let user = messages[index]; let assistant = messages[index + 1]
                guard user.role == "user", assistant.role == "assistant", assistant.complete else { continue }
                let bytes = user.text.utf8.count + assistant.text.utf8.count
                guard count + bytes <= 600 else { break }
                count += bytes
                history.insert(contentsOf: [Message(user.text, role: .user), Message(assistant.text, role: .model)], at: 0)
            }
        }
        messages.append(LocalChatMessage(role: "user", text: text))
        let reply = LocalChatMessage(role: "assistant", text: ""); messages.append(reply)
        save()
        request = Task {
            do {
                let chat = try await engine.createConversation(with: ConversationConfig(systemMessage: Message("你是 Ulemi。根据用户语言提供清楚、具体的回答。你在手机离线运行，无法访问网络或用户的云端应用。"), initialMessages: history, thinkingConfig: ThinkingConfig(enableThinking: false, thinkingTokenBudget: 0)))
                conversation = chat
                if Task.isCancelled { try? chat.cancel(); throw CancellationError() }
                for try await chunk in chat.sendMessageStream(Message(text), maxOutputTokens: 512) {
                    try Task.checkCancellation()
                    if let index = messages.firstIndex(where: { $0.id == reply.id }) { messages[index].text += chunk.toString }
                }
                if messages.last?.text.isEmpty == true { throw LocalModelError.message("模型没有返回文字，请重试。") }
                if let index = messages.firstIndex(where: { $0.id == reply.id }) { messages[index].complete = true }
            } catch {
                self.error = Task.isCancelled ? "已停止生成。" : "生成未完成：\(error.localizedDescription)"
            }
            conversation = nil; busy = false; request = nil; save()
            if pendingUnload { unload() }
        }
    }
    func stop() { try? conversation?.cancel(); request?.cancel() }
    func unload() {
        pendingUnload = true
        guard !busy else { stop(); return }
        conversation = nil; engine = nil; ready = false; pendingUnload = false
        state = ""
    }
    func clearChat() {
        guard !busy else { return }
        if !storageReadable {
            let original = directory.appendingPathComponent("chat.json")
            do { try FileManager.default.moveItem(at: original, to: directory.appendingPathComponent("chat-unreadable-\(UUID().uuidString).json")); storageReadable = true }
            catch { self.error = "旧对话未能备份，未清空。"; return }
        }
        messages = []; save()
    }
    func save() {
        guard storageReadable else { return }
        do { try JSONEncoder().encode(messages).write(to: directory.appendingPathComponent("chat.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
        catch { error = "这次对话未能保存，请勿关闭页面。" }
    }
}
