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
