import DevToolKit
import SwiftUI

/// `/plugins` (§8.28): the Claude Code plugins of the chat's folder, as the desktop's
/// sheet shows them. The desktop runs `claude plugin …` and reloads the chat's plugins.
struct PluginsSheet: View {
    /// False while the desktop is offline or only a saved copy shows.
    let editable: Bool
    let load: (_ query: String?) async throws -> ChatPluginsResult
    let change: (ChatPluginAction, String, ChatPluginScope?) async throws -> ChatPluginsChangeResult

    private enum Page: Hashable { case installed, marketplace }

    @Environment(\.dismiss) private var dismiss
    @State private var page: Page = .installed
    @State private var result: ChatPluginsResult?
    @State private var loadError: String?
    @State private var query = ""
    @State private var scope: ChatPluginScope = .user
    /// The plugin a change runs for. One at a time: they write the same settings files.
    @State private var busy: String?
    @State private var status: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let result {
                    list(result)
                } else if let loadError {
                    ContentUnavailableView {
                        Label("Can't show plugins", systemImage: "puzzlepiece.extension")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("Try again") { Task { await fetch() } }
                            .buttonStyle(.bordered)
                            .disabled(!editable)
                    }
                } else {
                    ProgressView("Loading plugins…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Plugins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if busy != nil {
                    ToolbarItem(placement: .topBarLeading) { ProgressView() }
                }
            }
        }
        .task { await fetch() }
        // The desktop searches; wait for a pause in the typing.
        .task(id: query) {
            guard result != nil else { return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await fetch()
        }
    }

    private func list(_ result: ChatPluginsResult) -> some View {
        List {
            Section {
                Picker("Plugins", selection: $page) {
                    Text("Installed (\(result.installed.count))").tag(Page.installed)
                    Text("Marketplace").tag(Page.marketplace)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            } footer: {
                if let error {
                    Text(error).foregroundStyle(.red)
                } else if let status {
                    Text(status)
                }
            }

            switch page {
            case .installed: installed(result.installed)
            case .marketplace: marketplace(result)
            }
        }
        .animation(.default, value: page)
    }

    @ViewBuilder
    private func installed(_ plugins: [ChatInstalledPlugin]) -> some View {
        Section {
            if plugins.isEmpty {
                Button("No plugins installed. Browse the marketplace") { page = .marketplace }
            }
            ForEach(plugins) { plugin in
                InstalledPluginRow(
                    plugin: plugin,
                    disabled: !editable || busy != nil,
                    toggle: { on in run(on ? .enable : .disable, plugin.pluginId, plugin.name, plugin.editableScope) }
                )
                .swipeActions(allowsFullSwipe: false) {
                    if editable, plugin.editableScope != nil, busy == nil {
                        Button("Uninstall", systemImage: "trash", role: .destructive) {
                            run(.uninstall, plugin.pluginId, plugin.name, plugin.editableScope)
                        }
                    }
                }
            }
        } footer: {
            if !plugins.isEmpty {
                Text("Swipe a plugin to uninstall it. Managed and claude.ai plugins can't be changed here.")
            }
        }
    }

    @ViewBuilder
    private func marketplace(_ result: ChatPluginsResult) -> some View {
        Section {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search \(result.availableCount) plugins", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            Picker("Install for", selection: $scope) {
                Text("User — all your projects").tag(ChatPluginScope.user)
                Text("Project — shared in git").tag(ChatPluginScope.project)
                Text("Local — this project, only you").tag(ChatPluginScope.local)
            }
            .disabled(!editable)
        }
        Section {
            if result.available.isEmpty {
                Text(result.availableCount == 0 ? "No marketplace is set up on the desktop." : "No plugin matches.")
                    .foregroundStyle(.secondary)
            }
            ForEach(result.available) { plugin in
                MarketplacePluginRow(
                    plugin: plugin,
                    installing: busy == plugin.id,
                    disabled: !editable || busy != nil,
                    install: { run(.install, plugin.id, plugin.name, scope) }
                )
            }
        }
    }

    private func run(_ action: ChatPluginAction, _ pluginId: String, _ name: String, _ scope: ChatPluginScope?) {
        guard editable, busy == nil else { return }
        busy = pluginId
        error = nil
        status = nil
        Task {
            defer { busy = nil }
            do {
                let outcome = try await change(action, pluginId, scope)
                let done = switch action {
                case .install: "Installed"
                case .uninstall: "Removed"
                case .enable: "Enabled"
                case .disable: "Disabled"
                }
                let where_ = if !outcome.reloaded {
                    "Applies from the next message."
                } else if let errors = outcome.pluginErrors, errors > 0 {
                    "Reloaded with \(errors) plugin error\(errors == 1 ? "" : "s")."
                } else {
                    "Applied to this chat now."
                }
                status = "\(done) \(name). \(where_)"
                await fetch()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func fetch() async {
        do {
            let fresh = try await load(query)
            result = fresh
            loadError = nil
        } catch is CancellationError {
            return
        } catch {
            if result == nil { loadError = error.localizedDescription } else { self.error = error.localizedDescription }
        }
    }
}

private struct InstalledPluginRow: View {
    let plugin: ChatInstalledPlugin
    let disabled: Bool
    let toggle: (Bool) -> Void

    var body: some View {
        Toggle(isOn: Binding(get: { plugin.enabled }, set: toggle)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin.name)
                    .foregroundStyle(plugin.enabled ? .primary : .secondary)
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(plugin.notes, id: \.self) { note in
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .disabled(disabled || plugin.editableScope == nil)
    }

    private var meta: String {
        [plugin.marketplace == plugin.scope ? nil : plugin.marketplace, plugin.scope, plugin.version.map { "v\($0)" }]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}

private struct MarketplacePluginRow: View {
    let plugin: ChatAvailablePlugin
    let installing: Bool
    let disabled: Bool
    let install: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin.name)
                Text(meta)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let description = plugin.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if plugin.installed {
                Text("Installed")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if installing {
                ProgressView()
            } else {
                Button("Install", action: install)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(disabled)
            }
        }
    }

    private var meta: String {
        [plugin.marketplace, plugin.installCount.map { "\(formatInstallCount($0)) installs" }]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}
