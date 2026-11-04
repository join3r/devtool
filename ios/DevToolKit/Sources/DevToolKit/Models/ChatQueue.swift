import Foundation

// Queue or steer (§8.24): `chat.send`'s `mode`, the view's `queue`, and
// `chat.queue`, behind `DesktopFeature.chatQueue`.

/// What a message sent mid-turn does: `steer` goes into the running turn now,
/// `queue` waits on the desktop and goes out when the turn ends.
public enum ChatSendMode: String, Sendable, Equatable, CaseIterable {
    case queue
    case steer

    /// The other one (what the composer's long press sends with).
    public var other: ChatSendMode { self == .queue ? .steer : .queue }
}

/// One message waiting for the turn to end.
public struct ChatQueued: Sendable, Equatable, Identifiable {
    public var id: String
    /// Capped at 16000 characters by the desktop.
    public var text: String
    /// Pictures that go with it; nil for none.
    public var images: Int?

    public init(id: String, text: String, images: Int? = nil) {
        self.id = id
        self.text = text
        self.images = images
    }
}

extension ChatQueued {
    static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatQueued {
        let f = try Fields(value, "queued message")
        let images = try f.optInt("images")
        return ChatQueued(id: try f.str("id"), text: try f.str("text"), images: images.flatMap { $0 > 0 ? Int($0) : nil })
    }

    var json: JSONValue {
        var o: JSONObject = ["id": .string(id), "text": .string(text)]
        if let images, images > 0 { o["images"] = .int(Int64(images)) }
        return .object(o)
    }
}

/// `chat.queue` params: edit, remove or send now one queued message.
public struct ChatQueueParams: Sendable, Equatable {
    public enum Action: String, Sendable, Equatable, CaseIterable {
        case edit
        case remove
        case send
    }

    public var tabId: String
    public var id: String
    public var action: Action
    /// The new text; only with `edit`.
    public var text: String?

    public init(tabId: String, id: String, action: Action, text: String? = nil) {
        self.tabId = tabId
        self.id = id
        self.action = action
        self.text = action == .edit ? text : nil
    }
}

extension ChatQueueParams {
    /// The desktop's side: a missing `tabId` or `id`, an unknown `action`, or an
    /// `edit` whose `text` is missing, blank or over `ChatOp.maxSendLength`
    /// characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatQueueParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let id = try o.str("id")
        guard let action = Action(rawValue: try o.str("action")) else { throw ProtocolError("unknown action") }
        guard action == .edit else { return ChatQueueParams(tabId: tabId, id: id, action: action) }
        let text = try o.str("text")
        if text.utf16.count > ChatOp.maxSendLength { throw ProtocolError("text over \(ChatOp.maxSendLength) characters") }
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ProtocolError("text is empty") }
        return ChatQueueParams(tabId: tabId, id: id, action: action, text: text)
    }

    public var json: JSONValue {
        var o: JSONObject = ["tabId": .string(tabId), "id": .string(id), "action": .string(action.rawValue)]
        if let text { o["text"] = .string(text) }
        return .object(o)
    }
}
