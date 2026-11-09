import Foundation

// `/plugins` (§8.28): `chat.plugins` and `chat.plugins.change`, behind one feature.

public enum ChatPluginAction: String, Sendable, Equatable, CaseIterable {
    case install, uninstall, enable, disable
}

/// The scopes a plugin can be installed in. Installed plugins can also be in others
/// (`managed`, `synced`), which the phone cannot change.
public enum ChatPluginScope: String, Sendable, Equatable, CaseIterable {
    case user, project, local
}

/// `chat.plugins` params: the chat, and the marketplace search (nil: the most installed).
public struct ChatPluginsParams: Sendable, Equatable {
    public var tabId: String
    public var query: String?

    public init(tabId: String, query: String? = nil) {
        self.tabId = tabId
        self.query = query
    }
}

/// A plugin installed for the chat's folder.
public struct ChatInstalledPlugin: Sendable, Equatable, Identifiable {
    /// `name@marketplace`.
    public var pluginId: String
    public var name: String
    public var marketplace: String
    public var version: String?
    /// `user`, `project` or `local`, or a scope the phone cannot change.
    public var scope: String
    public var enabled: Bool
    public var notes: [String]

    /// A plugin can be installed in more than one scope.
    public var id: String { "\(pluginId):\(scope)" }
    /// The scope as one the phone can change, else nil.
    public var editableScope: ChatPluginScope? { ChatPluginScope(rawValue: scope) }

    public init(pluginId: String, name: String, marketplace: String, version: String? = nil, scope: String, enabled: Bool, notes: [String] = []) {
        self.pluginId = pluginId
        self.name = name
        self.marketplace = marketplace
        self.version = version
        self.scope = scope
        self.enabled = enabled
        self.notes = notes
    }
}

/// A marketplace plugin that matched the search.
public struct ChatAvailablePlugin: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var marketplace: String
    public var description: String?
    public var installCount: Int64?
    public var installed: Bool

    public init(id: String, name: String, marketplace: String, description: String? = nil, installCount: Int64? = nil, installed: Bool = false) {
        self.id = id
        self.name = name
        self.marketplace = marketplace
        self.description = description
        self.installCount = installCount
        self.installed = installed
    }
}

/// `chat.plugins` result.
public struct ChatPluginsResult: Sendable, Equatable {
    public var installed: [ChatInstalledPlugin]
    /// At most `ChatOp.maxPluginMatches`.
    public var available: [ChatAvailablePlugin]
    /// All the marketplace plugins there are, before the search.
    public var availableCount: Int64

    public init(installed: [ChatInstalledPlugin], available: [ChatAvailablePlugin], availableCount: Int64) {
        self.installed = installed
        self.available = available
        self.availableCount = availableCount
    }
}

/// `chat.plugins.change` params: one install, removal, enable or disable.
public struct ChatPluginsChangeParams: Sendable, Equatable {
    public var tabId: String
    public var action: ChatPluginAction
    public var pluginId: String
    public var scope: ChatPluginScope?

    public init(tabId: String, action: ChatPluginAction, pluginId: String, scope: ChatPluginScope? = nil) {
        self.tabId = tabId
        self.action = action
        self.pluginId = pluginId
        self.scope = scope
    }
}

/// `chat.plugins.change` result.
public struct ChatPluginsChangeResult: Sendable, Equatable {
    /// The chat's running session loaded the change; false: it applies from the next message.
    public var reloaded: Bool
    /// Plugins that failed to load in that reload.
    public var pluginErrors: Int64?

    public init(reloaded: Bool = false, pluginErrors: Int64? = nil) {
        self.reloaded = reloaded
        self.pluginErrors = pluginErrors
    }
}

// MARK: - Wire

extension ChatPluginsParams {
    /// The desktop's side: a `query` over `ChatOp.maxPluginQueryLength` characters throws
    /// (`bad-request`); a blank one is absent.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatPluginsParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let query = try o.optStr("query")
        if let query, query.utf16.count > ChatOp.maxPluginQueryLength {
            throw ProtocolError("query over \(ChatOp.maxPluginQueryLength) characters")
        }
        let blank = query?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
        return ChatPluginsParams(tabId: tabId, query: blank ? nil : query)
    }

    public var json: JSONValue {
        var o: JSONObject = ["tabId": .string(tabId)]
        if let query { o["query"] = .string(query) }
        return .object(o)
    }
}

extension ChatPluginsResult {
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatPluginsResult {
        let o = try Fields(value, "result")
        let installed = try o.array("installed").map { (raw: JSONValue) throws(ProtocolError) -> ChatInstalledPlugin in
            let p = try Fields(raw, "plugin")
            return ChatInstalledPlugin(
                pluginId: try p.str("id"), name: try p.str("name"), marketplace: try p.str("marketplace"),
                version: try p.optStr("version"), scope: try p.str("scope"), enabled: try p.bool("enabled"),
                notes: p.isUnset("notes") ? [] : try p.strings("notes"))
        }
        let available = try o.array("available").map { (raw: JSONValue) throws(ProtocolError) -> ChatAvailablePlugin in
            let p = try Fields(raw, "plugin")
            return ChatAvailablePlugin(
                id: try p.str("id"), name: try p.str("name"), marketplace: try p.str("marketplace"),
                description: try p.optStr("description"), installCount: try p.optInt("installCount"), installed: p.flag("installed"))
        }
        return ChatPluginsResult(installed: installed, available: available, availableCount: try o.int("availableCount"))
    }

    public var json: JSONValue {
        .object([
            "installed": .array(installed.map { plugin in
                var o: JSONObject = [
                    "id": .string(plugin.pluginId), "name": .string(plugin.name), "marketplace": .string(plugin.marketplace),
                    "scope": .string(plugin.scope), "enabled": .bool(plugin.enabled),
                ]
                if let version = plugin.version { o["version"] = .string(version) }
                if !plugin.notes.isEmpty { o["notes"] = .array(plugin.notes.map(JSONValue.string)) }
                return .object(o)
            }),
            "available": .array(available.map { plugin in
                var o: JSONObject = ["id": .string(plugin.id), "name": .string(plugin.name), "marketplace": .string(plugin.marketplace)]
                if let description = plugin.description { o["description"] = .string(description) }
                if let installCount = plugin.installCount { o["installCount"] = .int(installCount) }
                if plugin.installed { o["installed"] = true }
                return .object(o)
            }),
            "availableCount": .int(availableCount),
        ])
    }
}

extension ChatPluginsChangeParams {
    /// The desktop's side: an unknown `action` or `scope`, or an empty `pluginId` or one
    /// over `ChatOp.maxPluginIdLength` characters throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatPluginsChangeParams {
        let o = try Fields(value, "params")
        let tabId = try o.str("tabId")
        let action = ChatPluginAction(rawValue: try o.oneOf("action", ChatPluginAction.allCases.map(\.rawValue)))!
        let pluginId = try o.str("pluginId")
        if pluginId.isEmpty { throw ProtocolError("pluginId is empty") }
        if pluginId.utf16.count > ChatOp.maxPluginIdLength { throw ProtocolError("pluginId over \(ChatOp.maxPluginIdLength) characters") }
        let scope = o.isUnset("scope") ? nil : ChatPluginScope(rawValue: try o.oneOf("scope", ChatPluginScope.allCases.map(\.rawValue)))
        return ChatPluginsChangeParams(tabId: tabId, action: action, pluginId: pluginId, scope: scope)
    }

    public var json: JSONValue {
        var o: JSONObject = ["tabId": .string(tabId), "action": .string(action.rawValue), "pluginId": .string(pluginId)]
        if let scope { o["scope"] = .string(scope.rawValue) }
        return .object(o)
    }
}

extension ChatPluginsChangeResult {
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> ChatPluginsChangeResult {
        let o = try Fields(value, "result")
        return ChatPluginsChangeResult(reloaded: o.flag("reloaded"), pluginErrors: try o.optInt("pluginErrors"))
    }

    public var json: JSONValue {
        var o: JSONObject = [:]
        if reloaded { o["reloaded"] = true }
        if let pluginErrors { o["pluginErrors"] = .int(pluginErrors) }
        return .object(o)
    }
}

// MARK: - The composer

extension ChatCommandMenu {
    /// `/plugins`, and the CLI's own `/plugin`: the phone's plugin sheet (§8.28).
    public static let plugins = "plugins"

    public static func isPlugins(_ name: String?) -> Bool {
        name == plugins || name == "plugin"
    }
}

/// Install counts as the desktop sheet shows them: `950`, `9.5k`, `478k`, `1.1M`.
public func formatInstallCount(_ count: Int64) -> String {
    func short(_ value: Double, _ unit: String) -> String {
        let text = String(format: value >= 10 ? "%.0f" : "%.1f", value)
        return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + unit
    }
    if count >= 1_000_000 { return short(Double(count) / 1_000_000, "M") }
    if count >= 1000 { return short(Double(count) / 1000, "k") }
    return String(count)
}
