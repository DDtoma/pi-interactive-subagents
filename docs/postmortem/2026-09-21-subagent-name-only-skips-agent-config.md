# Subagent spawned with `name` only silently ignores the agent definition

Date: 2026-09-21
Severity: medium — one subagent run used an unintended model; no data loss
Status: fixed

## Summary

A `reviewer` subagent launched on 2026-09-21 ran on the pi default model (`litellm/k3-256k`) instead of the model configured in `~/.pi/agent/agents/reviewer.md` (`litellm/glm-5.3`). The caller had passed only the `name` parameter to the `subagent` tool, and the extension loads an agent definition file only when the optional `agent` parameter is set, so every frontmatter default — model, thinking, tools — was silently dropped.

## Impact

- The 2026-09-21 17:33 (+0800) `reviewer` run used `litellm/k3-256k` instead of the configured `litellm/glm-5.3`; `thinking: high` from the same frontmatter was also not applied.
- All other frontmatter defaults (`tools`, `deny-tools`, `spawning`, `auto-exit`, `session-mode`) were equally inert for that run.
- No error or warning was emitted at any point; the failure is invisible from the tool result.

## Timeline

All times +0800.

| Time | Event | Evidence |
| --- | --- | --- |
| 2026-09-20 16:25 | `reviewer` spawned with both `agent: "reviewer"` and `name: "reviewer"`; frontmatter model applied (`--model 'minimax-cn/MiniMax-M3:high'`, the configured model at that time) | Session `2026-09-20T07-49-57-218Z_01a0bdcb-*.jsonl` tool-call arguments; launch script `reviewer-6a97a761.sh` |
| 2026-09-21 17:32 | `~/.pi/agent/agents/reviewer.md` edited; `model` changed to `litellm/glm-5.3` | File mtime 2026-09-21 17:32:20 |
| 2026-09-21 17:33 | `reviewer` spawned with `name: "reviewer"` only; generated launch script contains neither `PI_SUBAGENT_AGENT` nor `--model` | Launch script `reviewer-827de7c2.sh`; session `2026-09-21T09-30-50-915Z_01a0c34d-*.jsonl` tool-call arguments `{"name": "reviewer", "task": ...}` |
| 2026-09-21 | Root cause identified by reading `launchSubagent` | `pi-extension/subagents/index.ts:1069` |

## Root cause

Causal chain, trigger to impact:

1. The calling session invoked `subagent` with `name: "reviewer"` and no `agent`. The tool schema makes `agent` optional (`Type.Optional`, `pi-extension/subagents/index.ts:106-111`) and marks only `name` and `task` as required, so the call is valid and nothing signals that `agent` is the switch that loads configuration.
2. `launchSubagent` resolves defaults with `params.agent ? loadAgentDefaults(params.agent) : null` (index.ts:1069). With `agent` absent, no definition file is read. `name` is used only for display and instance identification: pane title (index.ts:1108), interrupt/watcher matching (index.ts:853), launch-script and sysprompt file names (index.ts:1185, 1313), and the `PI_SUBAGENT_NAME` env var (index.ts:1288).
3. With `agentDefs` null, `effectiveModel = params.model ?? agentDefs?.model` (index.ts:1070) is undefined, so the pi CLI command is built without `--model` (index.ts:1238-1243) and the child pi process falls back to `defaultProvider`/`defaultModel` from `settings.json` (`litellm/k3-256k`).

The configuration itself was not at fault: `reviewer.md` starts with `---`, uses LF line endings, and its `model:` line matches the `getFrontmatterValue` regex (index.ts:232-237); `glm-5.3` is present under the `litellm` provider in `~/.pi/agent/models.json`.

## Detection

A human noticed the run was on the default model and asked why; diagnosis happened the same day by comparing the generated launch scripts of the 09-20 and 09-21 runs. Nothing automated would have caught it: the launch script records the absence of `--model` only implicitly, and the tool result contains no indication of whether an agent definition was loaded. Printing the resolved definition source (or its absence) in the launch result would have surfaced the problem immediately.

## Prevention

| Action | Owner | Status | Link |
| --- | --- | --- | --- |
| Made `agent` a required parameter: the schema rejects calls without it, and a definition file that doesn't exist is a hard error listing the available agents. Ad-hoc subagents use the new bundled `general` definition (`agents/general.md`), which carries no overrides and preserves the previous bare-spawn behavior (`/iterate` now passes `agent: "general"`) | llight | done | — |
| The launch result now states which agent definition was loaded and which model it resolved to (e.g. "Agent definition \"reviewer\" loaded; model litellm/glm-5.3:high") | llight | done | — |
| Falling back to `name` when loading definitions was rejected: it would fuse display names with configuration keys, break descriptive display names and same-type parallel instances, and give ad-hoc spawns no way to opt out of a colliding definition | — | rejected | — |
