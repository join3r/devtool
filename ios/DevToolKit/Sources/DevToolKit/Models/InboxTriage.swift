import Foundation

/// One row of the phone's Inbox (§8.3): a task, with the desktop and project it belongs to.
public struct InboxEntry: Sendable, Equatable, Identifiable {
    public var desktopId: String
    public var project: InboxProject
    public var task: InboxTask
    /// The tasks it started that are still open (§8.26), each with its own;
    /// they are listed under this row, not on their own.
    public var children: [InboxEntry]
    /// In Needs you only because a task under it needs you: that task.
    public var bubbledFrom: InboxTask?

    public init(desktopId: String, project: InboxProject, task: InboxTask, children: [InboxEntry] = [], bubbledFrom: InboxTask? = nil) {
        self.desktopId = desktopId
        self.project = project
        self.task = task
        self.children = children
        self.bubbledFrom = bubbledFrom
    }

    public var id: String { "\(desktopId):\(task.id)" }

    /// Every task under this row, depth first.
    public var descendants: [InboxEntry] {
        children.flatMap { [$0] + $0.descendants }
    }
}

/// Which of the desktop inbox's groups a task is in (its `partitionInbox`).
public enum InboxGroup: Sendable, Equatable, CaseIterable {
    /// Blocked on you: a question, a permission prompt, a terminal bell.
    case needsYou
    /// The agent finished and you haven't answered.
    case yourTurn
    /// The agent is running: nothing for you to do yet.
    case working
    /// Nothing pending either way: you had the last word, or nothing has happened yet.
    case quiet
    case snoozed

    /// Still in the inbox: not snoozed.
    public var isOpen: Bool { self != .snoozed }
}

extension InboxTask {
    /// Waiting on you rather than the agent (the desktop's `isYourTurn`): it
    /// needs you, or its last event came after your last word.
    public var isYourTurn: Bool {
        // A stopped landing waits for you whatever its tabs do (§4.4).
        if landing?.needsYou == true { return true }
        if status == .working { return false }
        if status == .attention { return true }
        guard let eventAt else { return false }
        return eventAt > (lastInteractedAt ?? 0)
    }

    /// A live agent wins over snooze, as on the desktop.
    public func inboxGroup(now: Date) -> InboxGroup {
        if status == .attention { return .needsYou }
        // As the desktop's `partitionInbox`: ahead of working and snooze.
        if landing?.needsYou == true { return .yourTurn }
        if status == .working { return .working }
        // Waiting for tasks it started (§8.26) is not idle, a snooze notwithstanding.
        if waiting { return .working }
        if isSnoozed(now: now) { return .snoozed }
        return isYourTurn ? .yourTurn : .quiet
    }
}

/// The desktop inbox's groups (its `partitionInbox`), over every paired desktop.
public struct InboxPartition: Sendable, Equatable {
    /// Longest wait first.
    public var needsYou: [InboxEntry] = []
    /// The agent is idle and you can act: Your turn tasks first, then Quiet
    /// ones, each by most recent activity (the desktop's Ready group).
    public var ready: [InboxEntry] = []
    /// Most recent activity first; shown folded.
    public var working: [InboxEntry] = []
    /// Soonest wake first; "until it needs me" last.
    public var snoozed: [InboxEntry] = []

    public init() {}

    public init(_ inboxes: [(desktopId: String, inbox: Inbox)], now: Date) {
        var groups: [InboxGroup: [(InboxEntry, Int)]] = [:]
        var index = 0
        for (desktopId, inbox) in inboxes {
            for project in inbox.projects {
                // Started tasks go under the task that started them (§8.26); a
                // parent with a task under it that needs you moves to Needs you.
                for entry in Self.nest(desktopId: desktopId, project: project) {
                    var root = entry
                    var group = root.task.inboxGroup(now: now)
                    if group != .needsYou, let asking = root.descendants.first(where: { $0.task.inboxGroup(now: now) == .needsYou }) {
                        group = .needsYou
                        root.bubbledFrom = asking.task
                    }
                    groups[group, default: []].append((root, index))
                    index += 1
                }
            }
        }
        let nowMs = now.unixMilliseconds
        // Equal keys keep the desktops' own order, as the desktop's stable sort does.
        func sorted(_ group: InboxGroup, by key: (InboxTask) -> Int64, descending: Bool) -> [InboxEntry] {
            (groups[group] ?? []).sorted { a, b in
                let ka = key(a.0.task), kb = key(b.0.task)
                if ka != kb { return descending ? ka > kb : ka < kb }
                return a.1 < b.1
            }.map(\.0)
        }
        needsYou = sorted(.needsYou, by: { $0.since ?? nowMs }, descending: false)
        ready = sorted(.yourTurn, by: \.lastActivityAt, descending: true)
            + sorted(.quiet, by: \.lastActivityAt, descending: true)
        working = sorted(.working, by: \.lastActivityAt, descending: true)
        snoozed = sorted(.snoozed, by: { $0.snoozeUntilAttention ? Int64.max : ($0.snoozedUntil ?? Int64.max) }, descending: false)
    }

    public var isEmpty: Bool {
        needsYou.isEmpty && ready.isEmpty && working.isEmpty && snoozed.isEmpty
    }

    /// The project's tasks as rows: those another open task started sit in
    /// its `children`, in the project's order. A `parentTaskId` that isn't
    /// among the tasks (closed, or from a confused desktop) leaves the task a
    /// row of its own; so does a loop.
    public static func nest(desktopId: String, project: InboxProject) -> [InboxEntry] {
        let ids = Set(project.tasks.map(\.id))
        var parentOf: [String: String] = [:]
        for task in project.tasks {
            if let parent = task.parentTaskId, parent != task.id, ids.contains(parent) { parentOf[task.id] = parent }
        }
        // Cut loops where they close.
        for id in Array(parentOf.keys) {
            var seen: Set<String> = [id]
            var at = parentOf[id]
            while let current = at {
                if seen.contains(current) { parentOf[id] = nil; break }
                seen.insert(current)
                at = parentOf[current]
            }
        }
        var childrenOf: [String: [InboxTask]] = [:]
        for task in project.tasks {
            if let parent = parentOf[task.id] { childrenOf[parent, default: []].append(task) }
        }
        func build(_ task: InboxTask, _ seen: Set<String>) -> InboxEntry {
            let kids = (childrenOf[task.id] ?? []).filter { !seen.contains($0.id) }
            return InboxEntry(desktopId: desktopId, project: project, task: task,
                              children: kids.map { build($0, seen.union([$0.id])) })
        }
        return project.tasks.filter { parentOf[$0.id] == nil }.map { build($0, [$0.id]) }
    }

    /// The Inbox badge, as the desktop's: unread tasks that aren't snoozed.
    public var unreadCount: Int {
        (needsYou + ready + working).flatMap { [$0] + $0.descendants }.filter(\.task.unread).count
    }

    /// The open, unfolded groups gathered by project for the grouped layout
    /// (the desktop's `groupInboxByProject`): Needs you and Ready.
    /// A project sits where its most urgent task sits in the flat list and
    /// keeps that order inside. Working and Snoozed stay folded rows.
    public var byProject: [InboxProjectGroup] {
        InboxProjectGroup.group(needsYou + ready)
    }

    /// The one-line summary of a folded group: "claude-project · DevTool
    /// Streams Redesign, thumb · IOS application" (project · task, the
    /// group's order).
    public static func summary(_ entries: [InboxEntry]) -> String {
        entries.map { "\($0.project.name) · \($0.task.name)" }.joined(separator: ", ")
    }
}

/// One project's card in the grouped Inbox.
public struct InboxProjectGroup: Sendable, Equatable, Identifiable {
    public var desktopId: String
    public var project: InboxProject
    public var entries: [InboxEntry]

    public var id: String { "\(desktopId):\(project.id)" }

    public init(desktopId: String, project: InboxProject, entries: [InboxEntry]) {
        self.desktopId = desktopId
        self.project = project
        self.entries = entries
    }

    /// `entries` by project (per desktop), in order of first appearance.
    public static func group(_ entries: [InboxEntry]) -> [InboxProjectGroup] {
        var groups: [InboxProjectGroup] = []
        var index: [String: Int] = [:]
        for entry in entries {
            let key = "\(entry.desktopId):\(entry.project.id)"
            if let i = index[key] {
                groups[i].entries.append(entry)
            } else {
                index[key] = groups.count
                groups.append(InboxProjectGroup(desktopId: entry.desktopId, project: entry.project, entries: [entry]))
            }
        }
        return groups
    }
}

extension InboxTask {
    /// The task as the desktop will send it back after `action` (§8.11), for
    /// showing the change before the next inbox confirms it.
    public func applying(_ action: TaskTriageParams.Action, now: Date) -> InboxTask {
        var task = self
        switch action {
        case .read:
            task.unread = false
        case .unread:
            task.unread = true
        case .snooze(let until):
            task.snoozedUntil = until
            task.snoozeUntilAttention = false
            task.unread = false
        case .snoozeUntilAttention:
            task.snoozeUntilAttention = true
            task.snoozedUntil = nil
            task.unread = false
        case .unsnooze:
            task.snoozedUntil = nil
            task.snoozeUntilAttention = false
        }
        return task
    }
}

/// The desktop inbox's Snooze menu (its `snoozePresets`), in the phone's time zone.
public struct SnoozePreset: Sendable, Equatable, Identifiable {
    public var id: String
    public var label: String
    public var action: TaskTriageParams.Action
    /// When the task wakes; nil for "until it needs me".
    public var wakesAt: Date?

    public static func presets(now: Date, calendar: Calendar = .current) -> [SnoozePreset] {
        func at(dayOffset: Int, hour: Int) -> Date {
            let day = calendar.date(byAdding: .day, value: dayOffset, to: calendar.startOfDay(for: now)) ?? now
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
        }
        func preset(_ id: String, _ label: String, _ date: Date) -> SnoozePreset {
            SnoozePreset(id: id, label: label, action: .snooze(until: date.unixMilliseconds), wakesAt: date)
        }

        var presets = [
            SnoozePreset(id: "attention", label: "Until it needs me", action: .snoozeUntilAttention, wakesAt: nil),
            preset("hour", "1 hour", now.addingTimeInterval(3600)),
        ]
        let evening = at(dayOffset: 0, hour: 18)
        if evening > now { presets.append(preset("evening", "This evening", evening)) }
        presets.append(preset("tomorrow", "Tomorrow", at(dayOffset: 1, hour: 9)))
        // Next Monday; on a Monday, the one a week out.
        let weekday = calendar.component(.weekday, from: now) - 1 // Sunday = 0, as JS getDay()
        let daysToMonday = (8 - weekday) % 7 == 0 ? 7 : (8 - weekday) % 7
        presets.append(preset("monday", "Monday", at(dayOffset: daysToMonday, hour: 9)))
        return presets
    }
}
