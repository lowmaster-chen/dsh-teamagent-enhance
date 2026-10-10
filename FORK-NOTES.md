# FORK-NOTES

Personal enhancement fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (upstream `master`, forked 2026-10-10). Upstream currently does not accept external PRs, so enhancements are developed and documented here.

## Enhancement 1: Agent Teams mailbox timeline

Status: implemented (branch `enhance/mailbox-timeline`); typecheck/lint/build verification in progress

### Problem

Upstream `0.2.1` moved Team messaging to the direct-inbox model: `send_message` steers the message straight into the target inbox and the Lead Session log no longer records new message traffic. The `agentTeam` wire projection therefore cannot expose a team-wide message history, and the Web panel's documented limitation "no mailbox timeline" stands.

### Design

1. **New experimental plugin record `plugin:agent-team/message-sent`.**
   Written through the `appendPluginRecord` API (ignorable, plugin-namespaced, never enters the model-visible surface). Declared in `PluginRecordMap` from `packages/experimental/agent-team/src/types.ts`.
   Payload: `{ version: 1, teamId, record: { messageId, senderId, senderName, targetId, targetName, content, truncated } }`,
   where `content` is the first text block of the delivery, truncated to `timelineContentBytes` UTF-8 bytes (surrogate-pair safe).
   Appended **after** inbox acceptance in `sendAdmitted`; a failed append only logs a warning and never fails the already-accepted send (best-effort display record; a crash in the window can miss an entry).
2. **Projection.** `TeamState` gains a `sent` collection; `apply` recognizes the record (validates schema, `teamId`, `version`). The wire view gains `timeline` — the last `timelineLimit` records in log order. The view-cache key now includes the `sent` reference, so each accepted send republishes the view (bounded payload; trade-off documented below).
3. **Config.** New validated fields `timelineLimit` (default 64) and `timelineContentBytes` (default 1024) on the agent-team `Config`.
4. **Web panel.** A "Messages" section renders the sender → target route and the bounded content summary with a truncated tag. Locale-owned copy in `zh`/`en`.
5. **Format compatibility.** `SESSION_FORMAT_VERSION` stays 4: the record is ignorable, so builds that do not know the type keep and skip it; everything else in the log is unaffected.

### Trade-offs (documented in package READMEs)

- Every accepted send now republishes the complete wire view to connected browsers (an extension of upstream's documented full-view broadcast limitation).
- The timeline stores display summaries; full content remains in the target inbox.
- A record append failure leaves a timeline gap but never affects the accepted message.

### Verification

- `vitest` for `packages/experimental/agent-team` + `client-ui-agent-team`: 112 passed (includes 7 new timeline tests)
- `vitest` for `packages/experimental/tool-agent-team`: 29 passed (unchanged)
- `oxlint` on both touched packages: clean
- `tsc -b tsconfig.host.json`: clean; `tsdown --config-loader native --env.DSH_BUILD_FACE host`: clean; `tsc -b tsconfig.client.json`: clean (official build order)
- Keyless recorded-session snapshots replay on macOS/Linux only; no existing snapshot pins the `agentTeam` wire view. A new snapshot case for the timeline wire would be CI-owned upstream.
- Manual session walk-through recorded in the commit message

### File map

| File | Change |
| --- | --- |
| `packages/experimental/agent-team/src/types.ts` | record payload type + `PluginRecordMap` declaration + `Config` fields |
| `packages/experimental/agent-team/src/index.ts` | config validation + best-effort record append in `sendAdmitted` |
| `packages/experimental/agent-team/src/projection.ts` | `sent` collection, record recognition, wire `timeline`, cache key |
| `packages/experimental/agent-team/src/client.ts` | browser type surface |
| `packages/experimental/agent-team/tests/*.spec.ts` | projection + service tests |
| `packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx` | Messages section |
| `packages/experimental/client-ui-agent-team/src/client/locales.ts` | zh/en copy |
| `packages/experimental/client-ui-agent-team/tests/*.spec.tsx` | panel tests |
| `packages/experimental/{agent-team,client-ui-agent-team}/README.{md,zh.md}` | wire view + limitations |
| `docs/subsystems/agent-team.md` | wire projection section |
