import DevToolKit
import SwiftUI

/// What the schedule sheet opens on: a new schedule for a project, or one it has.
struct ScheduleTarget: Identifiable, Hashable {
    let desktopId: String
    let projectId: String
    /// The schedule to edit; nil makes one.
    var schedule: InboxSchedule?

    var id: String { "\(desktopId)/\(projectId)/\(schedule?.id ?? "new")" }
}

/// New schedule and Edit (§8.25): a name, the prompt each run starts with,
/// every N hours/days/weeks, the first run and, with more than one stream,
/// the stream. Editing also offers Run now, Pause/Resume and Delete. The
/// desktop answers each change; the schedule comes back with the next inbox.
struct ScheduleSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: ScheduleTarget

    @State private var name: String
    @State private var prompt: String
    @State private var every: Int
    @State private var unit: InboxSchedule.Unit
    @State private var firstRun: Date
    @State private var streamId: String?
    @State private var sending = false
    @State private var error: String?
    @State private var focused = false
    @State private var confirmDelete = false

    init(target: ScheduleTarget) {
        self.target = target
        let s = target.schedule
        _name = State(initialValue: s?.name ?? "")
        _prompt = State(initialValue: s?.prompt ?? "")
        _every = State(initialValue: s?.every ?? 1)
        _unit = State(initialValue: s?.unit ?? .week)
        // A new schedule's first run: tomorrow at 9:00.
        let tomorrow9 = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0,
                                              of: Calendar.current.date(byAdding: .day, value: 1, to: .now) ?? .now) ?? .now
        _firstRun = State(initialValue: s.map { Date(timeIntervalSince1970: TimeInterval($0.nextRunAt) / 1000) } ?? tomorrow9)
        _streamId = State(initialValue: s?.streamId)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let project {
                    Section {
                        LabeledContent("Project") { ProjectNameLabel(project: project) }
                        if project.streams.count > 1 {
                            Picker("Stream", selection: $streamId) {
                                ForEach(project.streams) { stream in
                                    StreamLabel(stream: stream).tag(stream.isMain ? nil : Optional(stream.id))
                                }
                            }
                            .pickerStyle(.navigationLink)
                            .disabled(sending)
                        }
                    } footer: {
                        if offline {
                            Text("\(model.desktop(target.desktopId)?.name ?? "This desktop") is offline.")
                        }
                    }
                }
                Section {
                    TextField("e.g. Agent SDK usage check", text: $name)
                        .disabled(sending)
                } header: {
                    Text("Name")
                }
                Section {
                    PromptTextView(text: $prompt, focused: $focused, placeholder: "What should each run check or do? Say what's worth reporting.",
                                   disabled: sending, onPasteImages: nil)
                } header: {
                    Text("Prompt")
                } footer: {
                    Text("Each run is a new Claude chat task. A run that finds nothing new closes itself; one with news stays in your Inbox.")
                }
                Section {
                    Stepper(value: $every, in: 1...InboxSchedule.maxEvery(unit)) {
                        Text(InboxSchedule(id: "", name: "", prompt: "", every: every, unit: unit, nextRunAt: 0).cadence.capitalizedFirst)
                    }
                    .disabled(sending)
                    Picker("Unit", selection: $unit) {
                        Text("Hours").tag(InboxSchedule.Unit.hour)
                        Text("Days").tag(InboxSchedule.Unit.day)
                        Text("Weeks").tag(InboxSchedule.Unit.week)
                    }
                    .pickerStyle(.segmented)
                    .disabled(sending)
                    .onChange(of: unit) { _, new in every = min(every, InboxSchedule.maxEvery(new)) }
                    DatePicker(target.schedule == nil ? "First run" : "Next run", selection: $firstRun, in: Date.now...)
                        .disabled(sending)
                } header: {
                    Text("When")
                } footer: {
                    Text("Runs need DevTool running on the desktop. Missed runs become one run when it starts again.")
                }
                if let schedule = target.schedule {
                    if gone {
                        Section {
                            Text("This schedule is gone. It may have been deleted on the desktop.")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Section {
                            Button("Run now", systemImage: "play.fill") { Task { await runNow(schedule) } }
                                .disabled(sending || offline)
                            Button(current?.paused == true ? "Resume" : "Pause",
                                   systemImage: current?.paused == true ? "play.circle" : "pause.circle") {
                                Task { await send { try await model.updateSchedule(.pause(scheduleId: schedule.id, paused: current?.paused != true), projectId: target.projectId, desktopId: target.desktopId) } }
                            }
                            .disabled(sending || offline)
                            Button("Delete schedule", systemImage: "trash", role: .destructive) { confirmDelete = true }
                                .disabled(sending || offline)
                        } footer: {
                            if let line = current?.lastRunLine { Text("Last run: \(line)") }
                        }
                    }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle(target.schedule == nil ? "New schedule" : "Schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button(target.schedule == nil ? "Add" : "Save") { Task { await save() } }
                            .disabled(!valid || offline || gone)
                    }
                }
            }
            .confirmationDialog("Delete this schedule?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    guard let schedule = target.schedule else { return }
                    Task { await send { try await model.updateSchedule(.remove(scheduleId: schedule.id), projectId: target.projectId, desktopId: target.desktopId) } }
                }
            } message: {
                Text("Runs already started stay open.")
            }
            .interactiveDismissDisabled(sending)
        }
    }

    private var project: InboxProject? {
        model.inboxes[target.desktopId]?.projects.first { $0.id == target.projectId }
    }

    /// The schedule as the latest inbox has it.
    private var current: InboxSchedule? {
        guard let id = target.schedule?.id else { return nil }
        return project?.schedules.first { $0.id == id }
    }

    private var gone: Bool { target.schedule != nil && project != nil && current == nil }
    private var offline: Bool { model.isOffline(target.desktopId) }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedPrompt: String { prompt.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool {
        !trimmedName.isEmpty && trimmedName.utf16.count <= InboxSchedule.nameLimit
            && !trimmedPrompt.isEmpty && trimmedPrompt.utf16.count <= InboxSchedule.promptLimit
    }

    private var startAt: Int64 { Int64(firstRun.timeIntervalSince1970 * 1000) }

    private func save() async {
        // A stream that has gone since the picker was filled: `main`.
        let stream = streamId.flatMap { id in project?.streams.first { $0.id == id } }
        if let schedule = target.schedule {
            var f = ScheduleUpdateParams.Fields()
            if trimmedName != schedule.name { f.name = trimmedName }
            if trimmedPrompt != schedule.prompt { f.prompt = trimmedPrompt }
            if every != schedule.every { f.every = every }
            if unit != schedule.unit { f.unit = unit }
            if stream?.id != schedule.streamId { f.streamId = .some(stream?.id) }
            if startAt / 60_000 != schedule.nextRunAt / 60_000 { f.startAt = startAt }
            await send { try await model.updateSchedule(.edit(scheduleId: schedule.id, f), projectId: target.projectId, desktopId: target.desktopId) }
        } else {
            let f = ScheduleUpdateParams.Fields(name: trimmedName, prompt: trimmedPrompt, every: every, unit: unit,
                                                streamId: stream.map { .some($0.id) } ?? nil, startAt: startAt)
            await send { try await model.updateSchedule(.add(f), projectId: target.projectId, desktopId: target.desktopId) }
        }
    }

    private func runNow(_ schedule: InboxSchedule) async {
        await send {
            guard let connection = model.connection(for: target.desktopId) else { throw DesktopConnectionError.notConnected }
            try await connection.runSchedule(projectId: target.projectId, scheduleId: schedule.id)
        }
    }

    /// Runs one request with the sheet locked, and closes it once the desktop says yes.
    private func send(_ work: () async throws -> Void) async {
        guard !sending else { return }
        sending = true
        error = nil
        do {
            try await work()
            dismiss()
        } catch {
            self.error = error.localizedDescription
            sending = false
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// A schedule on its project's screen: name, cadence and next run, and how its last run went.
struct ScheduleRow: View {
    let schedule: InboxSchedule
    let starting: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: schedule.paused ? "pause.circle" : "clock")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(schedule.name)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Text(when)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if starting {
                    Text("Starting…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else if let line = schedule.lastRunLine {
                    Text(line)
                        .font(.footnote)
                        .foregroundStyle(schedule.lastRun?.outcome == .failed ? .red : .secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if starting { ProgressView() }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the schedule")
    }

    private var when: String {
        let cadence = schedule.cadence.prefix(1).uppercased() + schedule.cadence.dropFirst()
        if schedule.paused { return "\(cadence) · Paused" }
        let next = Date(timeIntervalSince1970: TimeInterval(schedule.nextRunAt) / 1000)
        return "\(cadence) · next \(next.formatted(.relative(presentation: .named)))"
    }
}

/// A clock before the name of a task that is a schedule's run (§4.4 `scheduled`).
struct ScheduledMark: View {
    let task: InboxTask

    var body: some View {
        if let scheduled = task.scheduled {
            Image(systemName: "clock")
                .imageScale(.small)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Scheduled run of \(scheduled)")
        }
    }
}
