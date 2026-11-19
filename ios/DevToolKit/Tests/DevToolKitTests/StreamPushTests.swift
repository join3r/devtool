import Foundation
import Testing
@testable import DevToolKit

/// `stream.push.status` and `stream.push` (§8.29): the vectors in
/// `protocol/vectors/chat-messages.json`, and the mock.
@Suite struct StreamPushTests {
    @Test func vectors() throws {
        let file = try #require(try Vectors.load("chat-messages.json")["streamPush"])
        #expect(!file["params"].array.isEmpty && !file["statusResults"].array.isEmpty && !file["results"].array.isEmpty)
        for sample in file["params"].array {
            let parsed = try StreamPushParams.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["statusResults"].array {
            let parsed = try StreamPushStatus.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for sample in file["results"].array {
            let parsed = try StreamPushResult.parse(try JSONValue.parse(sample["json"].str))
            #expect(parsed.json == sample["expected"], "\(sample["json"].str)")
        }
        for json in file["invalid"]["params"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamPushParams.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["statusResults"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamPushStatus.parse(try JSONValue.parse(json.str)) }
        }
        for json in file["invalid"]["results"].array {
            #expect(throws: (any Error).self, "\(json.str)") { _ = try StreamPushResult.parse(try JSONValue.parse(json.str)) }
        }
    }

    @Test func pushLabel() {
        #expect(StreamPushStatus(branch: "master").pushLabel == nil)
        #expect(StreamPushStatus(branch: "master", remote: "origin").pushLabel == "Push to origin")
        #expect(StreamPushStatus(branch: "master", remote: "origin", ahead: 3).pushLabel == "Push to origin ↑3")
    }

    @Test func mockPushes() async throws {
        let mock = MockDesktopConnection(desktopId: "d", desktopName: "desk", flipInterval: .seconds(60), streamStep: .milliseconds(1))
        let events = EventRecorder(mock)
        await mock.start()
        try await events.waitFor(RelayConnectionTests.isInbox)

        #expect(try await mock.streamPushStatus(projectId: "p-api", streamId: "s-api-main")
            == StreamPushStatus(branch: "master", remote: "origin", upstream: "origin/master", ahead: 3))
        #expect(try await mock.streamPush(projectId: "p-api", streamId: "s-api-main")
            == StreamPushResult(status: .pushed, message: "Pushed 3 commits to origin/master", upstream: "origin/master", commits: 3))
        #expect(try await mock.streamPushStatus(projectId: "p-api", streamId: "s-api-main").ahead == 0)
        #expect(try await mock.streamPush(projectId: "p-api", streamId: "s-api-main").status == .nothing)

        // Never pushed: no upstream until the push sets one.
        #expect(try await mock.streamPushStatus(projectId: "p-api", streamId: "s-api-050")
            == StreamPushStatus(branch: "0.5.0", remote: "origin", ahead: 2))
        #expect(try await mock.streamPush(projectId: "p-api", streamId: "s-api-050").upstream == "origin/0.5.0")

        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.unsupported, message: "A shell-command project has no git branch to push.")) {
            _ = try await mock.streamPushStatus(projectId: "p-dotfiles", streamId: "s-dot-main")
        }
        await #expect(throws: DesktopConnectionError.remote(code: AppErrorCode.notFound, message: "No such stream")) {
            _ = try await mock.streamPush(projectId: "p-api", streamId: "missing")
        }
        await mock.stop()
    }
}
