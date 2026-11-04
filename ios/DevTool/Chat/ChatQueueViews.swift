import SwiftUI
import DevToolKit

/// What Enter-equivalent Send does mid-turn (§8.24), remembered across chats.
enum ChatSendModeSettings {
    static let key = "chatBusySendMode"
}

extension ChatSendMode {
    var label: String { self == .queue ? "Queue" : "Steer" }
    var symbol: String { self == .queue ? "text.append" : "arrow.turn.down.right" }
}

/// The Queue / Steer chip beside Send while the agent works: tap to swap.
struct ChatSendModeChip: View {
    @Binding var mode: ChatSendMode
    let agentName: String

    var body: some View {
        Button {
            mode = mode.other
        } label: {
            Label(mode.label, systemImage: mode.symbol)
                .font(.caption.weight(.medium))
                .labelStyle(.titleAndIcon)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .foregroundStyle(.secondary)
                .background(Color(.tertiarySystemFill), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode == .queue ? "Send queues the message" : "Send steers the running turn")
        .accessibilityHint("Switches to \(mode.other.label.lowercased())")
        .accessibilityIdentifier("chat.sendMode")
    }

    /// One line on what each does, for the Send button's long-press menu.
    static func help(_ mode: ChatSendMode, agentName: String) -> String {
        mode == .queue ? "Sent when \(agentName) finishes this turn" : "\(agentName) reads it at its next step"
    }
}

/// Messages queued mid-turn, above the composer (§8.24). Each goes out on its own
/// when the turn ends; until then it can be steered in now, edited or removed.
struct QueuedMessagesView: View {
    let queue: [ChatQueued]
    let busy: Bool
    let agentName: String
    let disabled: Bool
    let act: (ChatQueueParams.Action, ChatQueued) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(busy ? "Queued · sent when \(agentName) finishes" : "Queued · on hold since the turn stopped")
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(queue) { message in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(message.text)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let images = message.images {
                        Label("\(images)", systemImage: "photo")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Menu {
                        Button { act(.send, message) } label: {
                            Label(busy ? "Steer now" : "Send now", systemImage: "arrow.turn.down.right")
                        }
                        Button { act(.edit, message) } label: { Label("Edit", systemImage: "pencil") }
                        Button(role: .destructive) { act(.remove, message) } label: { Label("Remove", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .frame(width: 28, height: 28)
                    }
                    .disabled(disabled)
                    .accessibilityLabel("Queued message actions")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.queue")
    }
}

/// Editing one queued message.
struct QueuedMessageEditor: View {
    let message: ChatQueued
    let save: (String) -> Void
    @State private var text: String
    @Environment(\.dismiss) private var dismiss

    init(message: ChatQueued, save: @escaping (String) -> Void) {
        self.message = message
        self.save = save
        _text = State(initialValue: message.text)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding(.horizontal, 12)
                .navigationTitle("Queued message")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            if text != message.text { save(text) }
                            dismiss()
                        }
                        .disabled(trimmed.isEmpty || text.utf16.count > ChatOp.maxSendLength)
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}
