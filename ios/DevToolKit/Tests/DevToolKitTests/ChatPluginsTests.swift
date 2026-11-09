import Foundation
import Testing
@testable import DevToolKit

/// `/plugins` (§8.28): `chat.plugins` and `chat.plugins.change`.
@Suite struct ChatPluginsTests {
    @Test func pluginVectors() throws {
        let plugins = try #require(try Vectors.load("chat-messages.json")["plugins"])
        #expect(!plugins["params"].array.isEmpty && !plugins["results"].array.isEmpty)
        for sample in plugins["params"].array {
            let parsed = try ChatPluginsParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in plugins["results"].array {
            let parsed = try ChatPluginsResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in plugins["changeParams"].array {
            let parsed = try ChatPluginsChangeParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in plugins["changeResults"].array {
            let parsed = try ChatPluginsChangeResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in plugins["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatPluginsParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in plugins["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatPluginsResult.parse(try JSONValue.parse(json.str)) }
        }
        for json in plugins["invalid"]["changeParams"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatPluginsChangeParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in plugins["invalid"]["changeResults"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try ChatPluginsChangeResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func pluginsCommandNames() {
        #expect(ChatCommandMenu.isPlugins("plugins"))
        #expect(ChatCommandMenu.isPlugins("plugin"))
        #expect(!ChatCommandMenu.isPlugins("permissions"))
        #expect(!ChatCommandMenu.isPlugins(nil))
    }

    @Test func installCounts() {
        #expect(formatInstallCount(950) == "950")
        #expect(formatInstallCount(9500) == "9.5k")
        #expect(formatInstallCount(478_000) == "478k")
        #expect(formatInstallCount(1_124_000) == "1.1M")
        #expect(formatInstallCount(2_000_000) == "2M")
    }

    @Test func mockInstallsSearchesAndRemoves() async throws {
        let mock = MockDesktopConnection(desktopId: "m", desktopName: "mock", streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor { if case .features(let features) = $0 { features.contains(DesktopFeature.chatPlugins) } else { false } }
        try await events.waitFor { $0 == .state(.online) }
        _ = try await mock.openChat(tabId: "tab-1")

        let first = try await mock.chatPlugins(tabId: "tab-1")
        #expect(first.installed.map(\.name) == ["feature-dev", "security-guidance", "swift-lsp"])
        #expect(first.installed.first { $0.scope == "synced" }?.editableScope == nil)
        #expect(first.available.first?.name == "superpowers")

        let search = try await mock.chatPlugins(tabId: "tab-1", query: "review")
        // Names first, then descriptions ("built-in code review").
        #expect(search.available.map(\.name) == ["code-review", "superpowers"])

        let installed = try await mock.changeChatPlugin(.init(tabId: "tab-1", action: .install, pluginId: "code-review@claude-plugins-official", scope: .local))
        #expect(installed.reloaded)
        let after = try await mock.chatPlugins(tabId: "tab-1", query: "code")
        #expect(after.installed.contains { $0.name == "code-review" && $0.scope == "local" })
        #expect(after.available.first { $0.name == "code-review" }?.installed == true)

        _ = try await mock.changeChatPlugin(.init(tabId: "tab-1", action: .disable, pluginId: "code-review@claude-plugins-official", scope: .local))
        #expect(try await mock.chatPlugins(tabId: "tab-1").installed.first { $0.name == "code-review" }?.enabled == false)
        _ = try await mock.changeChatPlugin(.init(tabId: "tab-1", action: .uninstall, pluginId: "code-review@claude-plugins-official", scope: .local))
        #expect(try await mock.chatPlugins(tabId: "tab-1").installed.contains { $0.name == "code-review" } == false)

        await #expect(throws: (any Error).self) {
            _ = try await mock.changeChatPlugin(.init(tabId: "tab-1", action: .install, pluginId: "nope@nowhere"))
        }
        await #expect(throws: (any Error).self) { _ = try await mock.chatPlugins(tabId: "nope") }
    }
}
