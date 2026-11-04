import Foundation
import Testing
@testable import DevToolKit

/// Find in a chat thread (§8.23): `chat.search`.
@Suite struct ChatSearchTests {
    @Test func searchVectors() throws {
        let search = try #require(try Vectors.load("chat-messages.json")["search"])
        #expect(!search["params"].array.isEmpty && !search["results"].array.isEmpty)
        for sample in search["params"].array {
            let parsed = try ChatSearchParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in search["results"].array {
            let parsed = try ChatSearchResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in search["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatSearchParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in search["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str.prefix(80))") { _ = try ChatSearchResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func stepsThroughEveryOccurrence() {
        let matches = ChatSearchMatches(ChatSearchResult(matches: [
            ChatSearchHit(itemId: "u1", count: 1),
            ChatSearchHit(itemId: "t2", count: 3),
            ChatSearchHit(itemId: "a3", count: 1),
        ], total: 5))
        #expect(matches.count == 5)
        #expect((0..<5).map { matches.itemId(at: $0) } == ["u1", "t2", "t2", "t2", "a3"])
        #expect(matches.itemId(at: 5) == nil && matches.itemId(at: -1) == nil)
        #expect(matches.step(from: 4, by: 1) == 0)
        #expect(matches.step(from: 0, by: -1) == 4)
        #expect(matches.step(from: -1, by: -1) == 4)
        #expect(matches.step(from: -1, by: 1) == 0)
        #expect(matches.label(at: 1) == "2 of 5")
        #expect(matches.itemIds == ["u1", "t2", "a3"])
        #expect(ChatSearchMatches.empty.step(from: 0, by: 1) == -1)
        #expect(ChatSearchMatches.empty.label(at: -1) == "No matches")
    }

    @Test func numbersAcrossMatchesTheResultLeftOut() {
        // Only the newest items are listed: the older matches still count.
        let matches = ChatSearchMatches(ChatSearchResult(matches: [ChatSearchHit(itemId: "z", count: 2)], total: 9))
        #expect(matches.label(at: 0) == "8 of 9")
        #expect(matches.label(at: 1) == "9 of 9")
    }

    @Test func mockDesktopSearchesDetailsToo() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(5))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatSearch) } else { false } }
        try await events.waitFor { $0 == .state(.online) }
        let found = try await mock.searchChat(tabId: "tab-1", query: "REFRESHTOKEN")
        #expect(found.total > 0)
        #expect(found.total == found.matches.reduce(0) { $0 + $1.count })
        #expect(found.matches.contains { $0.itemId == "t1" })
        let none = try await mock.searchChat(tabId: "tab-1", query: "no-such-words-here")
        #expect(none == ChatSearchResult(matches: [], total: 0))
        await #expect(throws: DesktopConnectionError.self) { _ = try await mock.searchChat(tabId: "tab-1", query: "  ") }
        await #expect(throws: DesktopConnectionError.self) { _ = try await mock.searchChat(tabId: "nope", query: "x") }
    }
}
