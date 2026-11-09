import Foundation

/// New task's same-folder warning, as the desktop's (`busyInSameFolder`):
/// another task's agent already working in the folder a new task would start in.
extension InboxProject {
    /// Whether a new task in `stream` gets a worktree of its own: a worktree
    /// stream (`branch`), or `main` with `taskWorktrees`, in a project that
    /// isn't over SSH (§11).
    public func startsInOwnWorktree(_ stream: InboxStream?) -> Bool {
        guard let stream, !remote else { return false }
        return stream.branch != nil || stream.taskWorktrees
    }

    /// The working tasks in the folder a new task in `stream` (nil: `main`)
    /// would start in: the stream's worktree, which its tasks without a
    /// `branch` share, or the project folder, shared by every task without a
    /// `branch` in a stream without one. Empty when the task gets its own worktree.
    /// `streamFolder`: the task skips the worktree its stream gives (`task.folder`).
    public func busyInSameFolder(_ stream: InboxStream?, streamFolder: Bool = false) -> [InboxTask] {
        let target = stream ?? mainStream
        if startsInOwnWorktree(target), !streamFolder { return [] }
        let worktreeStreams = Set(streams.filter { $0.branch != nil }.map(\.id))
        return tasks.filter { task in
            guard task.status == .working, task.branch == nil else { return false }
            if let target, target.branch != nil { return task.streamId == target.id }
            return !worktreeStreams.contains(task.streamId)
        }
    }

    /// The warning's line: who works where, and what to do about it.
    public func sameFolderWarning(_ stream: InboxStream?, busy: [InboxTask]) -> String {
        let target = stream ?? mainStream
        let place = target?.branch != nil ? "the \(target?.name ?? "stream") worktree" : "the project folder"
        let who = busy.count == 1 ? "“\(busy[0].name)” is" : "\(busy.count) agents are"
        return "\(who) already working in \(place). Two agents there edit the same files."
    }
}

/// What a new task does when its folder is busy (`task.busy`, §8.4), as the
/// desktop's warning asks: wait, take a worktree of its own, or start there.
public enum BusyChoice: String, Sendable, Equatable, CaseIterable {
    case queue
    case worktree
    case here

    public var label: String {
        switch self {
        case .queue: "Queue"
        case .worktree: "Own worktree"
        case .here: "Start here"
        }
    }

    /// What `task.new` sends for it; nil starts the task in the folder now.
    public var start: TaskNewParams.Start? {
        switch self {
        case .queue: .queue
        case .worktree: .worktree
        case .here: nil
        }
    }
}

extension InboxProject {
    /// Whether a new task in `stream` (nil: `main`) can take a worktree of its
    /// own although the stream doesn't give them: `main` without
    /// `taskWorktrees`, in a project that isn't `remote`.
    public func canStartInOwnWorktree(_ stream: InboxStream?) -> Bool {
        guard let target = stream ?? mainStream, !remote else { return false }
        return target.isMain && target.branch == nil && !target.taskWorktrees
    }

    /// The warning's choices, the default first: Queue when the start can
    /// wait (no pictures), then Own worktree, and always Start here.
    public func busyChoices(_ stream: InboxStream?, canQueue: Bool) -> [BusyChoice] {
        (canQueue ? [.queue] : []) + (canStartInOwnWorktree(stream) ? [.worktree] : []) + [.here]
    }
}

/// The choice a start follows: none while the folder is free, else the picked
/// one while it is offered, else the default.
public func effectiveBusyChoice(busy: [InboxTask], choices: [BusyChoice], picked: BusyChoice?) -> BusyChoice? {
    guard !busy.isEmpty else { return nil }
    if let picked, choices.contains(picked) { return picked }
    return choices.first
}
