import Foundation
import Testing
@testable import DevToolKit

/// Queue or steer (§8.24): `chat.send`'s `mode`, the view's `queue`, `chat.queue`.
@Suite struct ChatQueueTests {
    @Test func queueVectors() throws {
        let queue = try #require(try Vectors.load("chat-messages.json")["queue"])
        #expect(!queue["params"].array.isEmpty && !queue["invalid"]["params"].array.isEmpty)
        for sample in queue["params"].array {
            let parsed = try ChatQueueParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in queue["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatQueueParams.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func sendCarriesItsMode() throws {
        #expect(ChatParams.send(tabId: "t", text: "hi", images: [], mode: .queue).json["mode"] == .string("queue"))
        #expect(ChatParams.send(tabId: "t", text: "hi", images: []).json["mode"] == nil)
        #expect(ChatSendMode.queue.other == .steer && ChatSendMode.steer.other == .queue)
        // `text` goes only with `edit`.
        #expect(ChatQueueParams(tabId: "t", id: "q", action: .remove, text: "x").text == nil)
    }

    @Test func mockDesktopQueuesUntilTheTurnEndsAndActsOnQueuedMessages() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatQueue) } else { false } }
        try await events.waitFor { $0 == .state(.online) }

        try await mock.sendChat(tabId: "tab-1", text: "first")
        #expect(try await mock.openChat(tabId: "tab-1").view.status.busy)
        try await mock.sendChat(tabId: "tab-1", text: "later one", mode: .queue)
        try await mock.sendChat(tabId: "tab-1", text: "later two", mode: .queue)
        var queue = try await mock.openChat(tabId: "tab-1").view.status.queue
        #expect(queue.map(\.text) == ["later one", "later two"])

        try await mock.queueChat(tabId: "tab-1", id: queue[0].id, action: .edit, text: "later one, edited")
        try await mock.queueChat(tabId: "tab-1", id: queue[1].id, action: .remove)
        queue = try await mock.openChat(tabId: "tab-1").view.status.queue
        #expect(queue.map(\.text) == ["later one, edited"])

        try await mock.queueChat(tabId: "tab-1", id: queue[0].id, action: .send)
        let view = try await mock.openChat(tabId: "tab-1").view
        #expect(view.status.queue.isEmpty)
        guard case .user(let text, _, _, _) = try #require(view.items.last { if case .user = $0.content { true } else { false } }).content else { return }
        #expect(text == "later one, edited")

        await #expect(throws: DesktopConnectionError.self) { try await mock.queueChat(tabId: "tab-1", id: queue[0].id, action: .remove) }
    }
}
