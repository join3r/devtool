import Foundation

// Fork a chat at one of its agent's replies (§8.27): `chat.fork`, behind its own feature.

/// `chat.fork` params: the chat and the `text` item the fork's conversation stops after.
public struct ChatForkParams: Sendable, Equatable {
    public var tabId: String
    public var itemId: String

    public init(tabId: String, itemId: String) {
        self.tabId = tabId
        self.itemId = itemId
    }
}

extension ChatForkParams {
    /// The desktop's side: a missing or empty `tabId` or `itemId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatForkParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let itemId = try o.str("itemId")
        if tabId.isEmpty || itemId.isEmpty { throw ProtocolError("tabId and itemId must not be empty") }
        return ChatForkParams(tabId: tabId, itemId: itemId)
    }

    public var json: JSONValue { .object(["tabId": .string(tabId), "itemId": .string(itemId)]) }
}

/// What a fork came to: the new task, idle, in the same stream.
public struct ChatForkResult: Sendable, Equatable {
    public var taskId: String
    public var name: String
    /// No worktree of its own: both agents edit the same folder.
    public var sharesFolder: Bool

    public init(taskId: String, name: String, sharesFolder: Bool = false) {
        self.taskId = taskId
        self.name = name
        self.sharesFolder = sharesFolder
    }
}

extension ChatForkResult {
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatForkResult {
        let o = try Fields(value, "result")
        return ChatForkResult(taskId: try o.str("taskId"), name: try o.str("name"), sharesFolder: o.flag("sharesFolder"))
    }

    public var json: JSONValue {
        var o: JSONObject = ["taskId": .string(taskId), "name": .string(name)]
        if sharesFolder { o["sharesFolder"] = true }
        return .object(o)
    }
}
