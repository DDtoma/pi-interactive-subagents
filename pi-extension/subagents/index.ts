import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  pollForExit,
  closeSurface,
  getMuxBackend,
  sendEscape,
  shellEscape,
} from "./cmux.ts";

import {
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  getStatusConfig,
} from "./status.ts";
import {
  activityLabel,
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
} from "./activity.ts";
import {
  discoverAgentDefinitions,
  getDefaultSessionDirFor,
  loadAgentDefaults,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehavior,
  resolveSubagentPaths,
  type AgentDefaults,
} from "./agents.ts";
import { renderSubagentWidgetLines } from "./widget.ts";
import {
  displayAgentTag,
  isGeneralAgent,
  parseCommaList,
  slugifyName,
} from "./util.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as
    | AbortController
    | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  // The controller is aborted on session_shutdown and on module re-import, but
  // nothing recreated it afterwards — every later spawn then watched an
  // already-aborted signal and failed instantly. Lazily replace a dead
  // controller so the extension recovers without requiring /reload.
  let controller = (globalThis as any)[POLL_ABORT_KEY] as
    | AbortController
    | undefined;
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    (globalThis as any)[POLL_ABORT_KEY] = controller;
  }
  return controller.signal;
}

const SubagentParams = Type.Object({
  name: Type.String({
    description:
      "Display name for the subagent (pane title, interrupt matching). Purely cosmetic — it does NOT select configuration; use `agent` for that.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.String({
    description:
      "Agent definition to load (e.g. 'Worker'). Required. Reads .pi/agents/<name>.md, ~/.pi/agent/agents/<name>.md, or the bundled agents dir; the call fails if no definition file exists. Use 'General' for an ad-hoc subagent with session defaults. Names match case-insensitively. Discover available agents with subagents_list.",
  }),
  systemPrompt: Type.Optional(
    Type.String({
      description: "Appended to system prompt (role instructions)",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override (overrides agent default)" }),
  ),
  skills: Type.Optional(
    Type.String({
      description: "Comma-separated skills (overrides agent default)",
    }),
  ),
  tools: Type.Optional(
    Type.String({
      description:
        "Comma-separated tools to restrict to (enforced via --tools on pi subagents; overrides agent default)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory; picks up its local .pi/ config, CLAUDE.md, skills, and extensions.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Inherit the current session conversation (full-context fork), overriding agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark interactive: long-running, user drives the conversation in its own terminal pane; stalled/recovered transitions won't wake the main session. Default: agent's `interactive` frontmatter, else inverse of `auto-exit`.",
    }),
  ),
});

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = getStatusConfig();

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode === 0
    ? `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  abortController?: AbortController;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. an /iterate fork).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(
            Array.from(runningSubagents.values()),
            width,
          );
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/**
 * Resolve the effective tool list for the child pi's --tools flag.
 *
 * Mirrors the host CLI semantics (docs/cli.md):
 * - plain names only → absolute allowlist; the control tools are appended so
 *   the subagent can always report completion
 * - only +name/-name modifiers → the child keeps its default tool selection
 *   with the modifiers applied; the control tools are force-added the same way
 * - mixing plain names and modifiers is rejected (the host CLI rejects it too)
 *
 * Returns null when no restriction was requested.
 */
function resolveAllowedTools(effectiveTools?: string): string[] | null {
  const requested = parseCommaList(effectiveTools);

  if (requested.length === 0) return null;

  const modifiers = requested.filter((tool) => /^[+-]/.test(tool));
  if (modifiers.length > 0 && modifiers.length < requested.length) {
    throw new Error(
      `Invalid tools list: plain names and +name/-name modifiers cannot be ` +
        `mixed. Use either an explicit allowlist or a pure modifier list that ` +
        `amends the child's default tool selection.`,
    );
  }

  if (modifiers.length > 0) {
    // Pure modifier list: keep the child's defaults, amend them, and make
    // sure the control tools stay reachable.
    return [...requested, "+caller_ping", "+subagent_done"];
  }

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }
  return [...allow];
}

/**
 * Build the pi CLI arguments enforcing the tool restriction, or an empty array
 * when no restriction was requested. The list always keeps the child control
 * tools reachable so the subagent can report completion. MCP tools the list
 * doesn't name stay registered but inactive — pi never declares them to the
 * model; only codemode/tool_search can reach them.
 */
function buildPiToolArgs(effectiveTools?: string): string[] {
  const allow = resolveAllowedTools(effectiveTools);
  if (!allow) return [];
  return ["--tools", allow.join(",")];
}

/** Sidecar next to a session file holding the spawn-time tools restriction. */
function getToolsSidecarFile(sessionFile: string): string {
  return `${sessionFile}.tools`;
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = parseCommaList(params.effectiveSkills).map(
    (skill) => `/skill:${skill}`,
  );

  const needsSeparator =
    params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

function observeRunningSubagent(
  running: RunningSubagent,
  observedAt = Date.now(),
) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  if (read.ok) {
    running.statusState = observeStatus(
      running.statusState,
      {
        snapshot: "present",
        updatedAt: read.activity.updatedAt,
        sequence: read.activity.sequence,
        phase: read.activity.phase,
        active: read.activity.phase === "active",
        activeScope: read.activity.activeScope,
        activeSince: read.activity.activeSince,
        waitingSince: read.activity.waitingSince,
        latestEvent: read.activity.latestEvent,
        activityLabel: activityLabel(read.activity),
      },
      observedAt,
    );
    return;
  }

  running.statusState = observeStatus(
    running.statusState,
    {
      snapshot: read.reason,
      snapshotError: read.error,
    },
    observedAt,
  );
}

function resolveInterruptTarget(params: {
  id?: string;
  name?: string;
}): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running
      ? { running }
      : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter(
    (running) => running.name === requestedName,
  );
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches
    .map((running) => `${running.name} [${running.id}]`)
    .join(", ");
  return {
    error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}`,
  };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
): {
  content: { type: "text"; text: string }[];
  details: { error?: string; id?: string; name?: string; status?: string };
} {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: {
        error: interruption.error,
        id: running.id,
        name: running.name,
      },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [
      {
        type: "text" as const,
        text: `Interrupt requested for subagent "${running.name}".`,
      },
    ],
    details: {
      id: running.id,
      name: running.name,
      status: "interrupt_requested",
    },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(
        running.statusState,
        now,
      );
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(
          formatTransitionLine(running.name, snapshot, transition),
        );
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(
            transitionLines,
            statusConfig.lineLimit,
          ),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): {
  autoExit: boolean;
  interactive: boolean;
} {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export const __test__ = {
  getShellReadyDelayMs,
  buildPiToolArgs,
  getToolsSidecarFile,
  buildPiPromptArgs,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  agentDefs: AgentDefaults,
  ctx: {
    sessionManager: {
      getSessionFile(): string | null | undefined;
      getSessionId(): string;
      getSessionDir(): string;
    };
    cwd: string;
  },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const effectiveModel = params.model ?? agentDefs.model;
  const effectiveTools = params.tools ?? agentDefs.tools;
  // Validate the allowlist (inside buildPiToolArgs) before any pane is
  // created — an invalid list would exit the child pi at launch and orphan
  // the pane.
  const toolArgs = buildPiToolArgs(effectiveTools);
  const effectiveSkills = params.skills ?? agentDefs.skills;
  const effectiveThinking = agentDefs.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(
    ctx.sessionManager.getSessionDir(),
    sessionId,
  );

  const { effectiveCwd, localAgentDir, effectiveAgentDir } =
    resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(
    targetCwdForSession,
    effectiveAgentDir,
  );

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp =
    new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, getShellReadyDelayMs()),
    );
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = agentDefs.autoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = agentDefs.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity =
    [agentDefs.body, params.systemPrompt].filter(Boolean).join("\n\n") ||
    null;
  const systemPromptMode = agentDefs.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock =
    identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // Enforce the tools allowlist: the child only gets the named tools plus
  // the control tools (always added by resolveAllowedTools).
  for (let i = 0; i + 1 < toolArgs.length; i += 2) {
    parts.push(toolArgs[i], shellEscape(toolArgs[i + 1]));
  }

  // Persist the restriction next to the session so subagent_resume can
  // re-apply it — resume has no agent definition to resolve the list from.
  if (effectiveTools?.trim()) {
    writeFileSync(getToolsSidecarFile(subagentSessionFile), effectiveTools, "utf8");
  }

  if (effectiveModel) {
    const model = effectiveThinking
      ? `${effectiveModel}:${effectiveThinking}`
      : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  // Pass agent body as system prompt via file to avoid shell escaping issues
  // with multiline content. Pi's --append-system-prompt and --system-prompt
  // auto-detect file paths and read their contents.
  if (identityInSystemPrompt && identity) {
    const flag =
      systemPromptMode === "replace"
        ? "--system-prompt"
        : "--append-system-prompt";
    const spTimestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const syspromptPath = join(
      artifactDir,
      `context/${slugifyName(params.name)}-sysprompt-${spTimestamp}.md`,
    );
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  // Build env prefix: denied tools + subagent identity + config dir propagation
  const envParts: string[] = [];

  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(
      `PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`,
    );
  }

  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  // `general` is the ad-hoc fallback definition, not a real identity —
  // tagging it would make the self-spawn guard block general→general
  // delegation and show "[general]" instead of the display name in the
  // child's tools widget.
  if (!isGeneralAgent(params.agent)) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const artifactName = `context/${slugifyName(params.name)}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${slugifyName(params.name)}-${id}.sh`;
  const launchScriptFile = join(
    artifactDir,
    "subagent-scripts",
    launchScriptName,
  );
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(
      surface,
      AbortSignal.any([signal, getModuleAbortSignal()]),
      {
        interval: 1000,
        sessionFile,
        onTick() {
          observeRunningSubagent(running);
        },
      },
    );

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode === 0
            ? "Sub-agent exited without output"
            : `Sub-agent exited with code ${result.exitCode}`);
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode === 0
          ? "Sub-agent exited without output"
          : `Sub-agent exited with code ${result.exitCode}`;
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch (closeErr) {
      // Best effort: the pane may already be gone.
      void closeErr;
    }
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      sessionFile,
    };
  }
}

/**
 * Deliver a finished watcher's outcome to the parent session: a help ping
 * when the subagent asked for it, otherwise the completion/failure
 * presentation. Shared by the subagent and subagent_resume watchers.
 */
function deliverWatcherResult(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: SubagentResult,
  options?: { summary?: string },
): void {
  updateWidget(); // reflect removal from Map immediately

  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.ping) {
    pi.sendMessage(
      {
        customType: "subagent_ping",
        content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
        display: true,
        details: {
          name: result.ping.name,
          message: result.ping.message,
          ...(running.agent ? { agent: running.agent } : {}),
          sessionFile: result.sessionFile,
        },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return;
  }

  const presentation = resolveResultPresentation(
    options?.summary != null ? { ...result, summary: options.summary } : result,
    running.name,
  );

  pi.sendMessage(
    {
      customType: "subagent_result",
      content: presentation,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        ...(running.agent ? { agent: running.agent } : {}),
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: result.sessionFile,
        ...(result.errorMessage
          ? { errorMessage: result.errorMessage }
          : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

/** Deliver a watcher crash (the promise rejected) to the parent session. */
function deliverWatcherError(
  pi: ExtensionAPI,
  running: RunningSubagent,
  err: any,
): void {
  updateWidget();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
      display: true,
      details: {
        name: running.name,
        task: running.task,
        error: err?.message,
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as
      | AbortController
      | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(parseCommaList(process.env.PI_DENY_TOOLS));

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent to handle a task. " +
        "Fire-and-forget: returns immediately with an acknowledgement; when it finishes, the harness delivers the result as a steer message that wakes you — " +
        "never poll, sleep, watch logs, or call subagents_list to detect completion, and never fabricate results. " +
        "After spawning, end your turn or work on independent tasks (parallel spawns OK).",
      promptSnippet:
        "Spawn an async sub-agent; its result is delivered automatically.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (an agent spawning another instance of itself)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (
          currentAgent &&
          params.agent?.toLowerCase() === currentAgent.toLowerCase()
        ) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // The agent definition is the only source of configured defaults —
        // fail loudly when it doesn't exist instead of silently launching
        // with session defaults.
        const agentDefs = loadAgentDefaults(params.agent);
        if (!agentDefs) {
          const available = discoverAgentDefinitions()
            .map((d) => d.name)
            .join(", ");
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: no agent definition found for "${params.agent}". ` +
                  `Available agents: ${available || "(none)"}. ` +
                  `Use agent: "General" for an ad-hoc subagent with session defaults.`,
              },
            ],
            details: {
              error: "agent definition not found",
              agent: params.agent,
            },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Validate the tools allowlist before launch — an invalid list would
        // exit the child pi at startup.
        try {
          resolveAllowedTools(params.tools ?? agentDefs.tools);
        } catch (error) {
          return {
            content: [
              { type: "text", text: `Error: ${(error as Error).message}` },
            ],
            details: { error: "invalid tools" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, agentDefs, ctx);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => deliverWatcherResult(pi, running, result))
          .catch((err) => deliverWatcherError(pi, running, err));

        // Return immediately
        const resolvedModel = params.model ?? agentDefs.model;
        let agentInfo = `Agent definition "${params.agent}" loaded; `;
        if (resolvedModel) {
          const thinkingSuffix = agentDefs.thinking
            ? `:${agentDefs.thinking}`
            : "";
          agentInfo += `model ${resolvedModel}${thinkingSuffix}. `;
        } else {
          agentInfo += "no model configured, using session default. ";
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                agentInfo +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            agentModel: resolvedModel ?? null,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : "(unnamed)";
        const task =
          typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent =
          typeof partialArgs.agent === "string" && partialArgs.agent
            ? theme.fg("dim", ` (${partialArgs.agent})`)
            : "";
        const cwdHint =
          typeof partialArgs.cwd === "string" && partialArgs.cwd
            ? theme.fg("dim", ` in ${partialArgs.cwd}`)
            : "";
        let text =
          "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine =
            task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview =
            firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a running Pi-backed subagent. " +
        "The pane, session, and watcher stay alive; returns a local acknowledgement only — no subagent_result is emitted for this.",
      promptSnippet: "Send Escape to a running subagent's active turn.",
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({ description: "Exact running subagent id" }),
        ),
        name: Type.Optional(
          Type.String({ description: "Exact running subagent display name" }),
        ),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : (args.name ?? "(unknown)");
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg(
                "toolTitle",
                theme.bold(details.name ?? details.id ?? "subagent"),
              ) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List available subagent definitions layered from bundled < global (~/.pi/agent/agents/) < project (.pi/agents/) < config (~/.pi/agent/subagents.json); higher layers override individual frontmatter fields.",
      promptSnippet: "List available subagent definitions.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter(
          (agent) => !agent.disableModelInvocation,
        );

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(
            theme.fg("dim", "No subagent definitions found."),
            0,
            0,
          );
        }
        const lines = agents.map((a: any) => {
          const badge =
            a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description
            ? theme.fg("dim", ` — ${a.description}`)
            : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new pane. " +
        "Fire-and-forget like the subagent tool: returns immediately; the harness delivers the result as a steer message that wakes you — never poll for status and never fabricate results. " +
        "Use for cancelled runs or follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session; result delivered automatically.",
      parameters: Type.Object({
        sessionPath: Type.String({
          description: "Path to the session .jsonl file to resume",
        }),
        name: Type.Optional(
          Type.String({
            description: "Display name for the terminal tab. Default: 'Resume'",
          }),
        ),
        message: Type.Optional(
          Type.String({
            description:
              "Message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Auto-exit after completing the response. Default true; set false for interactive sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const first = result.content[0];
        const text = first?.type === "text" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: session file not found: ${params.sessionPath}`,
              },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const surface = createSurface(name);
        await new Promise<void>((resolve) =>
          setTimeout(resolve, getShellReadyDelayMs()),
        );

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        // Re-apply the spawn-time tools restriction persisted next to the session.
        let resumeTools: string | undefined;
        try {
          resumeTools = readFileSync(
            getToolsSidecarFile(params.sessionPath),
            "utf8",
          );
        } catch {
          // No sidecar — the original session was unrestricted.
        }
        const resumeToolArgs = buildPiToolArgs(resumeTools);
        for (let i = 0; i + 1 < resumeToolArgs.length; i += 2) {
          parts.push(resumeToolArgs[i], shellEscape(resumeToolArgs[i + 1]));
        }

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(
          ctx.sessionManager.getSessionDir(),
          sessionId,
        );
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${slugifyName(name, "resume")}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(
            `PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`,
          );
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(
          `PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`,
        );
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(
          `PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`,
        );
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${slugifyName(name, "resume")}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile
              ? [`# Resume message file: ${resumeMsgFile}`]
              : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (result.ping) {
              deliverWatcherResult(pi, running, result);
              return;
            }

            // Only messages appended after the resume count — the session's
            // pre-resume history must not leak into the summary.
            const allEntries = getNewEntries(
              params.sessionPath,
              entryCountBefore,
            );
            const summary =
              findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode === 0
                  ? "Resumed session exited without new output"
                  : `Resumed session exited with code ${result.exitCode}`);
            deliverWatcherResult(pi, running, result, { summary });
          })
          .catch((err) => deliverWatcherError(pi, running, err));

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description:
      "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, agent: "General", name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, agent: "General", name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText =
        task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage =
          typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed =
          details.elapsed == null ? "?" : formatElapsed(details.elapsed);
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = theme.fg("dim", displayAgentTag(details.agent));

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent =
          typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(
            `Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`,
            "",
          )
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
            contentLines.push(
              theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
            );
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(
                theme.fg("muted", `… ${totalLines - 5} more lines`),
              );
            }
          }
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow =
      typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) =>
            theme.fg("dim", truncateToWidth(line, lineWidth)),
          ),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        const box = new Box(1, 1, (text: string) =>
          theme.bg("customMessageBg", text),
        );
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = theme.fg("dim", displayAgentTag(details.agent));
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(
              theme.fg("dim", `Session: ${details.sessionFile}`),
            );
          }
        } else {
          const preview = (details.message ?? "")
            .split("\n")[0]
            .slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(
            theme.fg("muted", keyHint("app.tools.expand", "to expand")),
          );
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
