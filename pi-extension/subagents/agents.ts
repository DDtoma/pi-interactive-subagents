/**
 * Agent definition loading: frontmatter parsing and the layered defaults
 * resolution (bundled < global < project < subagents.json overrides).
 */
import {
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { parseCommaList } from "./util.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults): Set<string> {
  const denied = new Set<string>();
  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of parseCommaList(agentDefs.denyTools)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory (host helper, respects PI_CODING_AGENT_DIR). */
function getAgentConfigDir(): string {
  return getAgentDir();
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function parseOptionalBoolean(
  value: string | boolean | undefined,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value === "boolean") return value;
  // Quoted frontmatter values arrive as text; accept case-insensitive
  // "true"/"false" so `spawning: False` no longer silently means false.
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function parseOptionalString(
  value: string | undefined,
): string | undefined {
  return value?.trim() || undefined;
}

function parseSessionMode(
  value: string | undefined,
): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  const { frontmatter, body } = parseFrontmatter(content);
  if (Object.keys(frontmatter).length === 0) return null;

  const get = (key: string): string | undefined =>
    parseOptionalString(
      typeof frontmatter[key] === "string" ? frontmatter[key] : undefined,
    );

  const systemPromptMode = get("system-prompt");

  return {
    name: get("name") ?? fallbackName,
    description: get("description"),
    model: get("model"),
    tools: get("tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: get("skill") ?? get("skills"),
    thinking: get("thinking"),
    denyTools: get("deny-tools"),
    spawning: parseOptionalBoolean(frontmatter["spawning"] as
      | string
      | boolean
      | undefined),
    autoExit: parseOptionalBoolean(frontmatter["auto-exit"] as
      | string
      | boolean
      | undefined),
    interactive: parseOptionalBoolean(frontmatter["interactive"] as
      | string
      | boolean
      | undefined),
    sessionMode: parseSessionMode(get("session-mode")),
    cwd: get("cwd"),
    body: body || undefined,
    disableModelInvocation: parseOptionalBoolean(
      frontmatter["disable-model-invocation"] as string | boolean | undefined,
    ),
  };
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) =>
      entry.endsWith(".md"),
    )) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      // Merge layers by lowercase name: a user-layer file may carry a
      // differently-cased name than the bundled one (e.g. worker vs Worker)
      // and must override it, not spawn a duplicate entry.
      const key = parsed.name.toLowerCase();
      const existing = agents.get(key);
      const mergedDef = existing
        ? mergeAgentDefaults(existing, parsed)
        : parsed;
      agents.set(key, { ...mergedDef, source });
    }
  }

  const overrides = loadAgentConfigOverrides();
  for (const [name, def] of agents) {
    const override = findAgentOverride(overrides, name);
    if (override) agents.set(name, mergeAgentDefaults(def, override));
  }

  return [...agents.values()];
}

export function resolveSubagentPaths(
  params: { cwd?: string },
  agentDefs: AgentDefaults,
): {
  effectiveCwd: string | null;
  localAgentDir: string | null;
  effectiveAgentDir: string;
} {
  const rawCwd = params.cwd ?? agentDefs.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd
    ? join(effectiveCwd, ".pi", "agent")
    : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

export function resolveEffectiveSessionMode(
  params: { fork?: boolean },
  agentDefs: AgentDefaults,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: { fork?: boolean },
  agentDefs: AgentDefaults,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (iterate/fork) and
 *      stall pings are noise.
 *
 * Agents without an `auto-exit` frontmatter field (e.g. the bundled
 * `general` agent used by `/iterate` with `fork: true`) have `autoExit`
 * undefined and are treated as interactive — matching the intent of iterate.
 */
export function resolveEffectiveInteractive(
  params: { interactive?: boolean },
  agentDefs: AgentDefaults,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs.interactive != null) return agentDefs.interactive;
  return !(agentDefs.autoExit ?? false);
}

/**
 * Overlay agent defaults field-by-field: fields the higher-priority layer
 * leaves undefined fall through to the lower layer. Lets a global/project
 * file tweak a single frontmatter field (e.g. `model:`) without forking the
 * whole bundled definition.
 */
function mergeAgentDefaults<T extends AgentDefaults>(
  base: T,
  overlay: AgentDefaults,
): T {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * JSON config overrides (`$PI_CODING_AGENT_DIR/subagents.json`), the
 * highest-priority layer above all agent .md files:
 *   { "agents": { "worker": { "model": "...", "thinking": "..." } } }
 * Only overrides existing agents — it cannot create new ones. Re-read on
 * every lookup so edits apply without /reload.
 */
function loadAgentConfigOverrides(): Record<string, AgentDefaults> {
  const path = join(getAgentConfigDir(), "subagents.json");
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid ${path}: ${(err as Error).message}`);
  }
  const agents = (parsed as { agents?: unknown })?.agents;
  if (agents == null) return {};
  if (typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error(`Invalid ${path}: "agents" must be an object`);
  }
  const booleanFields = [
    "spawning",
    "autoExit",
    "interactive",
    "disableModelInvocation",
  ] as const;
  for (const [name, def] of Object.entries(agents)) {
    if (def == null || typeof def !== "object" || Array.isArray(def)) {
      throw new Error(`Invalid ${path}: agents.${name} must be an object`);
    }
    for (const field of booleanFields) {
      const value = (def as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "boolean") {
        throw new Error(
          `Invalid ${path}: agents.${name}.${field} must be a boolean`,
        );
      }
    }
  }
  // Keys are matched case-insensitively: agent display names may differ in
  // case from the config keys (e.g. frontmatter "Worker" vs config "worker").
  const normalized: Record<string, AgentDefaults> = {};
  for (const [name, def] of Object.entries(
    agents as Record<string, AgentDefaults>,
  )) {
    normalized[name.toLowerCase()] = def;
  }
  return normalized;
}

/** Look up a config override by agent name, case-insensitively. */
export function findAgentOverride(
  overrides: Record<string, AgentDefaults>,
  agentName: string,
): AgentDefaults | undefined {
  return overrides[agentName.toLowerCase()];
}

/**
 * Resolve `<dir>/<agentName>.md`, falling back to a case-insensitive
 * filename match so `agent: "worker"` and `agent: "Worker"` load the same
 * definition regardless of how the file is named.
 */
function resolveAgentFile(dir: string, agentName: string): string | null {
  const exact = join(dir, `${agentName}.md`);
  if (existsSync(exact)) return exact;
  if (!existsSync(dir)) return null;
  const lower = `${agentName.toLowerCase()}.md`;
  const match = readdirSync(dir).find(
    (entry) => entry.toLowerCase() === lower,
  );
  return match ? join(dir, match) : null;
}

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  // Lowest to highest priority: bundled < global < project.
  const paths = [
    resolveAgentFile(getBundledAgentsDir(), agentName),
    resolveAgentFile(join(configDir, "agents"), agentName),
    resolveAgentFile(join(process.cwd(), ".pi", "agents"), agentName),
  ];

  let merged: AgentDefaults | null = null;
  for (const p of paths) {
    if (!p) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (!parsed) continue;
    merged = merged ? mergeAgentDefaults(merged, parsed) : parsed;
  }
  if (!merged) return null;
  const override = findAgentOverride(loadAgentConfigOverrides(), agentName);
  return override ? mergeAgentDefaults(merged, override) : merged;
}
