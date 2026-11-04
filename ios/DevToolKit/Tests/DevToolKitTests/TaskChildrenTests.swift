import Foundation
import Testing
@testable import DevToolKit

/// Tasks started by another task (§8.26): nested under their parent in the
/// Inbox, the parent waiting for them, and `task.close`'s `children`.
@Suite struct TaskChildrenTests {
    static let now = Date(unixMilliseconds: 1_790_000_000_000)

    func inbox(_ tasks: [InboxTask]) -> Inbox {
        Inbox(desktop: InboxDesktop(id: "d", name: "d"), generatedAt: 1, projects: [InboxProject(id: "p", name: "p", tasks: tasks)])
    }

    @Test func decodesTheFields() throws {
        let json = #"{"id":"a","name":"A","streamId":"s","streamName":"main","status":"idle","parentTaskId":"p1","children":{"total":3,"done":2,"working":1,"needsYou":0},"waiting":true,"tabs":[]}"#
        let task = try JSONDecoder().decode(InboxTask.self, from: Data(json.utf8))
        #expect(task.parentTaskId == "p1")
        #expect(task.children == InboxTaskChildren(total: 3, done: 2, working: 1, needsYou: 0))
        #expect(task.children?.line == "2 of 3 done")
        #expect(task.waiting)
        // An older desktop sends none of them.
        let old = try JSONDecoder().decode(InboxTask.self, from: Data(#"{"id":"a","name":"A","tabs":[]}"#.utf8))
        #expect(old.parentTaskId == nil && old.children == nil && !old.waiting)
    }

    @Test func aWaitingParentIsWorkingEvenSnoozed() {
        let parent = InboxTask(id: "p", name: "P", snoozeUntilAttention: true, waiting: true, tabs: [])
        #expect(parent.inboxGroup(now: Self.now) == .working)
    }

    @Test func nestsStartedTasksUnderTheirParent() {
        let partition = InboxPartition([("d", inbox([
            InboxTask(id: "parent", name: "P", children: InboxTaskChildren(total: 2, done: 0, working: 2), waiting: true, tabs: []),
            InboxTask(id: "a", name: "A", status: .working, parentTaskId: "parent", tabs: []),
            InboxTask(id: "a1", name: "A1", status: .working, parentTaskId: "a", tabs: []),
            InboxTask(id: "orphan", name: "O", parentTaskId: "gone", tabs: []),
        ]))], now: Self.now)
        #expect(partition.working.map(\.task.id) == ["parent"])
        #expect(partition.working.first?.children.map(\.task.id) == ["a"])
        #expect(partition.working.first?.descendants.map(\.task.id) == ["a", "a1"])
        #expect(partition.ready.map(\.task.id) == ["orphan"])
    }

    @Test func aParentMovesToNeedsYouForATaskUnderIt() {
        let partition = InboxPartition([("d", inbox([
            InboxTask(id: "parent", name: "P", tabs: []),
            InboxTask(id: "a", name: "A", status: .attention, parentTaskId: "parent", tabs: []),
        ]))], now: Self.now)
        #expect(partition.needsYou.map(\.task.id) == ["parent"])
        #expect(partition.needsYou.first?.bubbledFrom?.id == "a")
    }

    @Test func closeCarriesChildren() throws {
        let params = TaskCloseParams(taskId: "t", children: .stop)
        #expect(params.json == .object(["taskId": .string("t"), "children": .string("stop")]))
        #expect(try TaskCloseParams.parse(params.json) == params)
    }
}
