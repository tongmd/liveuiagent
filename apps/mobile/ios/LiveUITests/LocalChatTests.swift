import XCTest
@testable import LiveUI

@MainActor
final class LocalChatTests: XCTestCase {
    private func unreadableChat() throws -> (URL, URL) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let chat = folder.appendingPathComponent("chat.json", isDirectory: true)
        try FileManager.default.createDirectory(at: chat, withIntermediateDirectories: true)
        try Data("preserve this original content".utf8).write(to: chat.appendingPathComponent("original.txt"))
        return (folder, chat)
    }

    func testExistingUnreadableChatReportsErrorAndSavePreservesIt() throws {
        let (folder, original) = try unreadableChat()
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = LocalChat(directory: folder)
        XCTAssertNotNil(model.error, "An existing path that cannot be read must not be treated as an empty chat")
        model.messages = [LocalChatMessage(role: "user", text: "new text")]
        model.save()
        XCTAssertTrue((try original.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true)
        XCTAssertEqual(try Data(contentsOf: original.appendingPathComponent("original.txt")), Data("preserve this original content".utf8))
    }

    func testExplicitNewChatBacksUpUnreadableOriginalBeforeReplacingPath() throws {
        let (folder, original) = try unreadableChat()
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = LocalChat(directory: folder)
        XCTAssertNotNil(model.error)
        model.clearChat()
        let backups = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("chat-unreadable-") }
        XCTAssertEqual(backups.count, 1)
        let backup = try XCTUnwrap(backups.first)
        XCTAssertEqual(try Data(contentsOf: backup.appendingPathComponent("original.txt")), Data("preserve this original content".utf8))
        let fresh = try JSONDecoder().decode([LocalChatMessage].self, from: Data(contentsOf: original))
        XCTAssertTrue(fresh.isEmpty)
    }
}
