import Foundation

// Find in a chat thread (§8.23): `chat.search`, behind its own feature. The
// desktop searches the whole chat; the phone steps through the matches and
// loads older items with `chat.earlier` to reach one before its window.

/// `chat.search` params.
public struct ChatSearchParams: Sendable, Equatable {
    public var tabId: String
    public var query: String

    public init(tabId: String, query: String) {
        self.tabId = tabId
        self.query = query
    }
}

extension ChatSearchParams {
    /// The desktop's side: a missing `tabId`, or a blank query or one over
    /// `ChatOp.maxSearchLength` characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatSearchParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let query = try o.str("query")
        if query.utf16.count > ChatOp.maxSearchLength { throw ProtocolError("query over \(ChatOp.maxSearchLength) characters") }
        if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("query is empty") }
        return ChatSearchParams(tabId: tabId, query: query)
    }

    public var json: JSONValue { .object(["tabId": .string(tabId), "query": .string(query)]) }
}

/// One matching item and how many times it matches.
public struct ChatSearchHit: Sendable, Equatable {
    public var itemId: String
    public var count: Int

    public init(itemId: String, count: Int) {
        self.itemId = itemId
        self.count = count
    }
}

/// `chat.search` result: matching items oldest first (the newest 5000 when more
/// match) and the number of matches in the whole chat.
public struct ChatSearchResult: Sendable, Equatable {
    public var matches: [ChatSearchHit]
    public var total: Int

    public init(matches: [ChatSearchHit], total: Int) {
        self.matches = matches
        self.total = total
    }
}

extension ChatSearchResult {
    public static func parse(_ value: JSONValue) throws(ProtocolError) -> ChatSearchResult {
        let f = try Fields(value, "result")
        var matches: [ChatSearchHit] = []
        for raw in try f.array("matches") {
            let hit = try Fields(raw, "match")
            let count = try hit.int("count")
            if count < 1 { throw ProtocolError("count must be at least 1") }
            matches.append(ChatSearchHit(itemId: try hit.str("itemId"), count: Int(count)))
        }
        return ChatSearchResult(matches: matches, total: Int(try f.int("total")))
    }

    public var json: JSONValue {
        .object([
            "matches": .array(matches.map { .object(["itemId": .string($0.itemId), "count": .number(Double($0.count))]) }),
            "total": .number(Double(total)),
        ])
    }
}

/// Steps through a search's matches, one per occurrence: an item that matches
/// three times is three stops, as on the desktop.
public struct ChatSearchMatches: Sendable, Equatable {
    public let hits: [ChatSearchHit]
    /// Every match in the chat, also ones in items the result left out.
    public let total: Int
    /// The first match of each hit.
    private let starts: [Int]
    /// The matches listed (stops); at most `total`.
    public let count: Int
    /// Every matching item.
    public let itemIds: Set<String>

    public init(_ result: ChatSearchResult) {
        hits = result.matches
        var starts: [Int] = []
        var count = 0
        for hit in result.matches {
            starts.append(count)
            count += hit.count
        }
        self.starts = starts
        self.count = count
        total = max(result.total, count)
        itemIds = Set(result.matches.map(\.itemId))
    }

    public static let empty = ChatSearchMatches(ChatSearchResult(matches: [], total: 0))

    /// The item stop `index` is in.
    public func itemId(at index: Int) -> String? {
        guard index >= 0, index < count else { return nil }
        var low = 0
        var high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= index { low = mid } else { high = mid - 1 }
        }
        return hits[low].itemId
    }

    /// The stop after (`by: 1`) or before (`by: -1`) `index`, wrapping around;
    /// from nowhere (-1), the first or the last.
    public func step(from index: Int, by direction: Int) -> Int {
        guard count > 0 else { return -1 }
        if index < 0 || index >= count { return direction >= 0 ? 0 : count - 1 }
        return (index + direction % count + count) % count
    }

    /// "3 of 12", numbered across the whole chat (stops the result left out come first).
    public func label(at index: Int) -> String {
        if total == 0 { return "No matches" }
        guard index >= 0, index < count else { return total == 1 ? "1 match" : "\(total) matches" }
        return "\(total - count + index + 1) of \(total)"
    }
}
