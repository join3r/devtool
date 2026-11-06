/**
 * Shared names for the inbox hook protocol (local HTTP + SSH reverse tunnel).
 *
 * The Pi status extension is a plain ESM file loaded by `pi` itself, so it
 * cannot import this module — keep the header / env strings in
 * `resources/pi-status-extension.mjs` in sync with these constants.
 */

/** Header the hook server requires on every POST. */
export const HOOK_TOKEN_HEADER = 'X-Devtool-Token'

/** Tab that should receive the inbox/status event. */
export const HOOK_TAB_ID_HEADER = 'X-Tab-Id'

/** Env var: hook-server port (local) or reverse-forwarded port (SSH remote). */
export const HOOK_PORT_ENV = 'DEVTOOL_HOOK_PORT'

/** Env var: shared secret minted when the hook server starts. */
export const HOOK_TOKEN_ENV = 'DEVTOOL_HOOK_TOKEN'

/**
 * Env var: the tab's own token (`HookServer.tabToken`) for its task's land /
 * update. Set with {@link HOOK_PORT_ENV} on every agent spawn, and the agent's
 * note names both rather than their values: a resumed Claude keeps the system
 * prompt of its first start, while port and token change with every DevTool start.
 */
export const TASK_TOKEN_ENV = 'DEVTOOL_TASK_TOKEN'

/**
 * Reject hook bodies larger than this (bytes). PostToolUse carries the whole
 * `tool_response` (a Read of a big file, long Bash output), so this is sized for
 * that rather than for the small lifecycle events. A dropped PostToolUse only
 * leaves a stale tool label until the next tool call or Stop.
 */
export const MAX_HOOK_BODY_BYTES = 4 * 1024 * 1024
