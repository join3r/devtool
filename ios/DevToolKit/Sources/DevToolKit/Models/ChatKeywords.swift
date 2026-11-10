import Foundation

/// A word in a prompt that the Claude Code CLI reacts to. The composer shows a
/// label for each one in the draft. The desktop keeps the same list
/// (`CHAT_PROMPT_KEYWORDS` in src/shared/claude-chat.ts).
public struct ChatPromptKeyword: Sendable, Equatable, Hashable {
    public var word: String
    public var label: String
    public var description: String

    public static let all: [ChatPromptKeyword] = [
        ChatPromptKeyword(word: "ultrathink", label: "Ultrathink", description: "Claude thinks more deeply on this turn"),
        ChatPromptKeyword(word: "ultracode", label: "Workflow", description: "Claude can run a multi-agent workflow for this message")
    ]

    /// The keywords in `text`, in list order: whole words, any case.
    public static func found(in text: String) -> [ChatPromptKeyword] {
        all.filter { keyword in
            let pattern = "(^|[^\\p{L}\\p{N}_])\(keyword.word)(?![\\p{L}\\p{N}_])"
            return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }
}
