import Testing
@testable import DevToolKit

/// The desktop's `tests/desk-same-folder.test.ts`, on the phone's inbox shape.
@Suite struct SharedFolderTests {
    let main = InboxStream(id: "main", name: "main", isMain: true)
    let folder = InboxStream(id: "f", name: "notes")
    let release = InboxStream(id: "r", name: "release", branch: "release")

    func task(_ id: String, _ stream: InboxStream, working: Bool = true, branch: String? = nil) -> InboxTask {
        InboxTask(id: id, name: id, streamId: stream.id, streamName: stream.name,
                  status: working ? .working : .idle, branch: branch, tabs: [])
    }

    @Test func namesWorkingTasksInTheProjectFolder() {
        let project = InboxProject(id: "p", name: "p", streams: [main, folder, release], tasks: [
            task("a", main), task("b", folder), task("idle", main, working: false),
            task("own", release, branch: "release--own"), task("shared", release)
        ])
        #expect(project.busyInSameFolder(nil).map(\.id) == ["a", "b"])
        #expect(project.busyInSameFolder(folder).map(\.id) == ["a", "b"])
    }

    @Test func quietWhenTheNewTaskGetsItsOwnWorktree() {
        let project = InboxProject(id: "p", name: "p", streams: [main, release], tasks: [task("shared", release)])
        #expect(project.busyInSameFolder(release).isEmpty)
    }

    @Test func quietInMainWithTaskWorktrees() {
        let own = InboxStream(id: "main", name: "main", isMain: true, taskWorktrees: true)
        let project = InboxProject(id: "p", name: "p", streams: [own, release], tasks: [task("a", own)])
        #expect(project.busyInSameFolder(nil).isEmpty)
        #expect(project.busyInSameFolder(own).isEmpty)
    }

    @Test func streamFolderWarnsAboutTheStreamsOwnFolder() {
        let own = InboxStream(id: "main", name: "main", isMain: true, taskWorktrees: true)
        let project = InboxProject(id: "p", name: "p", streams: [own, release], tasks: [
            task("a", own), task("mine", own, branch: "main--mine"), task("x", release)
        ])
        #expect(project.busyInSameFolder(own, streamFolder: true).map(\.id) == ["a"])
        #expect(project.busyInSameFolder(release, streamFolder: true).map(\.id) == ["x"])
    }

    @Test func overSSHAWorktreeStreamIsShared() {
        let project = InboxProject(id: "p", name: "p", remote: true, streams: [main, release], tasks: [
            task("x", release), task("m", main)
        ])
        let busy = project.busyInSameFolder(release)
        #expect(busy.map(\.id) == ["x"])
        #expect(project.sameFolderWarning(release, busy: busy).hasPrefix("“x” is already working in the release worktree"))
    }

    @Test func busyChoicesInMainWithoutTaskWorktrees() {
        let project = InboxProject(id: "p", name: "p", streams: [main, release], tasks: [task("a", main)])
        let busy = project.busyInSameFolder(nil)
        let choices = project.busyChoices(nil, canQueue: true)
        #expect(choices == [.queue, .worktree, .here])
        #expect(effectiveBusyChoice(busy: busy, choices: choices, picked: nil) == .queue)
        #expect(effectiveBusyChoice(busy: busy, choices: choices, picked: .worktree) == .worktree)
        #expect(effectiveBusyChoice(busy: [], choices: choices, picked: .here) == nil)
        // Pictures don't wait in the queue: Own worktree comes first.
        #expect(project.busyChoices(nil, canQueue: false) == [.worktree, .here])
        #expect(BusyChoice.queue.start == .queue && BusyChoice.here.start == nil)
    }

    @Test func noOwnWorktreeOutsideMainOrOverSSH() {
        let project = InboxProject(id: "p", name: "p", streams: [main, folder], tasks: [])
        #expect(!project.canStartInOwnWorktree(folder))
        #expect(project.canStartInOwnWorktree(nil))
        let remote = InboxProject(id: "p", name: "p", remote: true, streams: [main], tasks: [])
        #expect(!remote.canStartInOwnWorktree(nil))
    }
}
