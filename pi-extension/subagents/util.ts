/** Parse a comma-separated list (env vars, frontmatter fields) into trimmed entries. */
export function parseCommaList(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Slugify a display name for artifact file names: lowercase, hyphenated, safe chars only. */
export function slugifyName(name: string, fallback = "subagent"): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  );
}

/** `general` is the ad-hoc fallback definition, not a real identity. */
export function isGeneralAgent(agent: string | undefined | null): boolean {
  return agent?.toLowerCase() === "general";
}

/** Render the ` (agent)` tag shown next to display names; `general` gets none. */
export function displayAgentTag(agent: string | undefined | null): string {
  return agent && !isGeneralAgent(agent) ? ` (${agent})` : "";
}
