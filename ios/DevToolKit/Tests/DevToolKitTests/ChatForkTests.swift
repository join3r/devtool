import Foundation
import Testing
@testable import DevToolKit

/// Fork a chat at an agent reply (§8.27): `chat.fork`.
@Suite struct ChatForkTests {
    @Test func forkVectors() throws {
        let fork = try #require(try Vectors.load("chat-messages.json")["fork"])
        #expect(!fork["params"].array.isEmpty && !fork["results"].array.isEmpty)
        for sample in fork["params"].array {
            let parsed = try ChatForkParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in fork["results"].array {
            let parsed = try ChatForkResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in fork["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatForkParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in fork["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatForkResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func forkableRoundTrips() throws {
        let item = try ChatItem.parse(try JSONValue.parse(#"{"kind":"text","id":"a1","markdown":"Done.","forkable":true}"#))
        #expect(item.forkable)
        #expect(item.json == (try JSONValue.parse(#"{"kind":"text","id":"a1","markdown":"Done.","forkable":true}"#)))
        let plain = try ChatItem.parse(try JSONValue.parse(#"{"kind":"text","id":"a2","markdown":"Hi","streaming":true}"#))
        #expect(!plain.forkable)
    }

    @Test func mockForksAForkableReply() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatFork) } else { false } }
        try await events.waitFor { $0 == .state(.online) }
        let opened = try await mock.openChat(tabId: "tab-1")
        let item = try #require(opened.view.items.first(where: { $0.forkable }))
        let result = try await mock.forkChat(tabId: "tab-1", itemId: item.id)
        #expect(result.name.hasSuffix("(fork)"))
        await #expect(throws: (any Error).self) { _ = try await mock.forkChat(tabId: "tab-1", itemId: "nope") }
    }
}
