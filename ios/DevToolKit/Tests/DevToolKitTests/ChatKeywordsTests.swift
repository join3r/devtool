import Testing
@testable import DevToolKit

/// Prompt keywords: the same results as the desktop's `chatPromptKeywords`.
@Suite struct ChatKeywordsTests {
    @Test func findsWholeWordsInAnyCase() {
        #expect(ChatPromptKeyword.found(in: "please ultrathink about this").map(\.word) == ["ultrathink"])
        #expect(ChatPromptKeyword.found(in: "ULTRACODE: fix it, Ultrathink.").map(\.word) == ["ultrathink", "ultracode"])
        #expect(ChatPromptKeyword.found(in: "ultrathinking ultracoder xultrathink ultra_think").isEmpty)
        #expect(ChatPromptKeyword.found(in: "").isEmpty)
    }
}
