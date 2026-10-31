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
            if FileManager.default.fileExists(atPath: chat.path) {
                let data = try Data(contentsOf: chat)
                messages = try JSONDecoder().decode([LocalChatMessage].self, from: data)
            }
        } catch { self.storageReadable = false; self.error = "Your saved conversation could not be read. The original file is unchanged." }
    }
    static func feedback(_ error: Error, fallback: String) -> String {
        // Our errors have reviewed English copy. Never expose localized OS/SDK details.
        if let local = error as? LocalModelError { return local.errorDescription ?? fallback }
        return fallback
    }
    func select(_ id: String) {
        guard !downloading, !busy else { return }
        unload(); selectedID = id; UserDefaults.standard.set(id, forKey: "ulemi.local.model"); state = ""; error = nil
    }
    func download() {
        guard !downloading, !busy else { return }
        do {
            let capacity = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
            guard capacity >= model.bytes + 1_073_741_824 else { throw LocalModelError.message("Free up at least \(model.sizeLabel) plus 1 GB before downloading.") }
            guard ProcessInfo.processInfo.physicalMemory >= model.minimumRAM else { throw LocalModelError.message("This device needs a smaller model. Choose E2B.") }
            autoLoad = true; error = nil; downloading = true; progress = 0; state = "Downloading. Setup will begin automatically."
            let ticket = UUID(); generation = ticket
            let transfer = ModelDownload(model: model, destination: file, cellular: cellular, progress: { [weak self] value in
                Task { @MainActor in guard let self, self.generation == ticket else { return }; self.progress = value }
            }, completion: { [weak self] result in
                Task { @MainActor in
                    guard let self, self.generation == ticket else { return }
                    self.downloading = false; self.downloader = nil
                    switch result {
                    case .success: self.progress = 1; if self.autoLoad { self.load() }
                    case .failure(let error): self.error = Self.feedback(error, fallback: "Download failed. Check your connection and try again."); self.state = ""
                    }
                }
            })
            downloader = transfer; transfer.start()
        } catch { self.error = Self.feedback(error, fallback: "The model could not be prepared. Please try again.") }
    }
    func pauseDownload() { autoLoad = false; downloader?.pause() }
    func removeDownload() {
        guard !downloading, !busy else { return }
        unload()
        do {
            for url in [file, file.appendingPathExtension("resume")] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            state = "Model removed. Your conversations are saved."; error = nil
        } catch { self.error = "The model could not be removed. Please try again." }
    }
    func load() {
        guard !busy, !downloading else { return }
        #if targetEnvironment(simulator)
        error = "Run local models on an iPhone 16 or later. The simulator is not supported."
        return
        #else
        guard ProcessInfo.processInfo.physicalMemory >= model.minimumRAM else { error = "Not enough memory. Choose E2B."; return }
        pendingUnload = false; busy = true; ready = false; error = nil; state = "Preparing your model…"
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
                engine = instance; ready = true; state = "\(selected.title) · \(backend) · Ready offline"
            } catch { self.error = Self.feedback(error, fallback: "The model could not be loaded. Try again or choose E2B."); engine = nil; state = "" }
            busy = false; request = nil
            if pendingUnload { unload() }
        }
        #endif
    }
    func send(_ input: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ready, !busy, let engine, !text.isEmpty else { return }
        guard storageReadable else { error = "This conversation could not be read. Choose New chat to back it up and start again."; return }
        guard text.utf8.count <= 1200 else { error = "Please shorten this message to 1,200 bytes or less."; return }
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
                let chat = try await engine.createConversation(with: ConversationConfig(systemMessage: Message("You are Ulemi. Reply clearly and concretely in the user’s language. You run offline on their phone and cannot access the internet or their cloud apps."), initialMessages: history, thinkingConfig: ThinkingConfig(enableThinking: false, thinkingTokenBudget: 0)))
                conversation = chat
                if Task.isCancelled { try? chat.cancel(); throw CancellationError() }
                for try await chunk in chat.sendMessageStream(Message(text), maxOutputTokens: 512) {
                    try Task.checkCancellation()
                    if let index = messages.firstIndex(where: { $0.id == reply.id }) { messages[index].text += chunk.toString }
                }
                if messages.last?.text.isEmpty == true { throw LocalModelError.message("The model returned no text. Please try again.") }
                if let index = messages.firstIndex(where: { $0.id == reply.id }) { messages[index].complete = true }
            } catch {
                self.error = Task.isCancelled ? "Generation stopped." : Self.feedback(error, fallback: "Generation did not finish. Please try again.")
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
            catch { self.error = "Your conversation could not be backed up. It has not been cleared."; return }
        }
        messages = []; save()
    }
    func save() {
        guard storageReadable else { return }
        do { try JSONEncoder().encode(messages).write(to: directory.appendingPathComponent("chat.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
        catch { self.error = "This conversation could not be saved. Keep this screen open." }
    }
}
