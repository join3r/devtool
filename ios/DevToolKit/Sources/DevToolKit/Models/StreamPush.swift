import Foundation

// Push a stream's branch to its remote (§8.29): `stream.push.status` and
// `stream.push`, behind the `stream.push` feature.

/// `stream.push.status` and `stream.push` params.
public struct StreamPushParams: Sendable, Equatable {
    public var projectId: String
    public var streamId: String

    public init(projectId: String, streamId: String) {
        self.projectId = projectId
        self.streamId = streamId
    }

    /// The desktop's side: a missing `projectId` or `streamId` throws (`bad-request`).
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamPushParams {
        let o = try Fields(value, "params")
        return StreamPushParams(projectId: try o.str("projectId"), streamId: try o.str("streamId"))
    }

    public var json: JSONValue { .object(["projectId": .string(projectId), "streamId": .string(streamId)]) }
}

/// Where the stream's branch stands, against the remote-tracking refs as last
/// fetched (nothing is fetched).
public struct StreamPushStatus: Sendable, Equatable {
    public var branch: String
    /// Where a push goes; nil when the repo has no remote (nothing to push to).
    public var remote: String?
    /// `origin/master`; nil while the branch was never pushed.
    public var upstream: String?
    /// Commits the remote lacks.
    public var ahead: Int
    /// Commits of `upstream` the branch lacks.
    public var behind: Int

    public init(branch: String, remote: String? = nil, upstream: String? = nil, ahead: Int = 0, behind: Int = 0) {
        self.branch = branch
        self.remote = remote
        self.upstream = upstream
        self.ahead = ahead
        self.behind = behind
    }

    /// An empty `remote` or `upstream` is nil; a missing, negative or fractional count throws.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamPushStatus {
        let o = try Fields(value, "result")
        let remote = try o.optStr("remote")
        let upstream = try o.optStr("upstream")
        return StreamPushStatus(branch: try o.str("branch"), remote: remote?.isEmpty == false ? remote : nil,
                                upstream: upstream?.isEmpty == false ? upstream : nil,
                                ahead: Int(try o.int("ahead")), behind: Int(try o.int("behind")))
    }

    public var json: JSONValue {
        var o: JSONObject = ["branch": .string(branch), "ahead": .int(Int64(ahead)), "behind": .int(Int64(behind))]
        if let remote { o["remote"] = .string(remote) }
        if let upstream { o["upstream"] = .string(upstream) }
        return .object(o)
    }

    /// The menu item: "Push to origin", with "↑3" while the remote lacks commits.
    public var pushLabel: String? {
        guard let remote else { return nil }
        return ahead > 0 ? "Push to \(remote) ↑\(ahead)" : "Push to \(remote)"
    }
}

/// What a push came to. A failed push is still a result, not an error.
public struct StreamPushResult: Sendable, Equatable {
    public enum Status: String, Sendable, Equatable, CaseIterable {
        /// With `upstream` and `commits`.
        case pushed
        /// The remote had it all; with `upstream`.
        case nothing
        /// The remote has commits the branch doesn't.
        case rejected
        /// git couldn't log in.
        case auth
        case noRemote = "no-remote"
        case failed
    }

    public var status: Status
    /// A line to show as it is.
    public var message: String
    public var upstream: String?
    /// How many commits the remote lacked (`pushed`).
    public var commits: Int?

    public init(status: Status, message: String, upstream: String? = nil, commits: Int? = nil) {
        self.status = status
        self.message = message
        self.upstream = upstream
        self.commits = commits
    }

    /// An unknown `status` is a malformed answer; an empty `upstream` is nil.
    public static func parse(_ value: JSONValue?) throws(ProtocolError) -> StreamPushResult {
        let o = try Fields(value, "result")
        guard let status = Status(rawValue: try o.str("status")) else { throw ProtocolError("status has an unknown value") }
        let upstream = try o.optStr("upstream")
        // As TS: only an absent `commits` is none; `null` is malformed.
        let commits = o.has("commits") ? Int(try o.int("commits")) : nil
        return StreamPushResult(status: status, message: try o.str("message"), upstream: upstream?.isEmpty == false ? upstream : nil,
                                commits: commits)
    }

    public var json: JSONValue {
        var o: JSONObject = ["status": .string(status.rawValue), "message": .string(message)]
        if let upstream { o["upstream"] = .string(upstream) }
        if let commits { o["commits"] = .int(Int64(commits)) }
        return .object(o)
    }

    /// Worth an error look rather than a plain notice.
    public var isFailure: Bool { status != .pushed && status != .nothing }
}

extension TaskOp {
    /// `stream.push.status` (§8.29): where a stream's branch stands against its remote.
    public static let streamPushStatus = "stream.push.status"
    /// `stream.push` (§8.29): push a stream's branch, never forced.
    public static let streamPush = "stream.push"
}
