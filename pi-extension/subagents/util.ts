/** Parse a comma-separated list (env vars, frontmatter fields) into trimmed entries. */
export function parseCommaList(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
