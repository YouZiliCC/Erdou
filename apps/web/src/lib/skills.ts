import type { FileSystemApi } from "@erdou/runtime-contract";

// Skills = task playbooks the agent reads before doing a specific kind of task
// (making a .pptx/.docx/.xlsx/.pdf, …). They live in the VFS at
// /.skills/<name>/SKILL.md so the agent reads them with read_file like any file.
// Built-in skills ship with the app and are seeded into a fresh project (see
// Studio.seedSkills); a user can add one by dropping a folder under /.skills/.

/** A built-in skill bundled with the app: its top folder name + every file
 *  (relative path → text content) to seed into /.skills/<name>/. */
export interface BuiltinSkill {
  name: string;
  files: Record<string, string>;
}

/** A discovered skill the agent is told about (progressive disclosure — only the
 *  pointer, never the body). Structurally matches agent-core's SkillBrief. */
export interface SkillBrief {
  name: string;
  description: string;
  path: string;
}

// Bundle the built-in skill sources at build time. Vite inlines each file's raw
// text; keys are module-relative paths like "./skills/pptx/SKILL.md".
const RAW = import.meta.glob("./skills/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const BUILTIN_SKILLS: BuiltinSkill[] = buildBuiltins(RAW);

function buildBuiltins(raw: Record<string, string>): BuiltinSkill[] {
  const byName = new Map<string, Record<string, string>>();
  for (const [absPath, content] of Object.entries(raw)) {
    const m = absPath.match(/\/skills\/([^/]+)\/(.+)$/);
    const name = m?.[1];
    const rel = m?.[2];
    if (!name || !rel) continue;
    let files = byName.get(name);
    if (!files) {
      files = {};
      byName.set(name, files);
    }
    files[rel] = content;
  }
  return [...byName.entries()].map(([name, files]) => ({ name, files }));
}

/**
 * Parse the leading `---`-fenced frontmatter of a SKILL.md. Only `name` and
 * `description` are read (values may contain colons; surrounding quotes are
 * stripped). No frontmatter → `{}`, and the caller treats a skill without both
 * fields as malformed (skipped + warned) rather than guessing.
 */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const body = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (body === undefined) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    const key = kv?.[1];
    const rawValue = kv?.[2];
    if (key === undefined || rawValue === undefined) continue;
    const value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (key === "name") out.name = value;
    else if (key === "description") out.description = value;
  }
  return out;
}

/**
 * Discover skills under /.skills/<name>/SKILL.md in the VFS. Returns a brief per
 * valid skill plus warnings for malformed ones (missing SKILL.md, or frontmatter
 * lacking name/description) so the app can surface them — fail-loud, never a
 * silent guess.
 */
export function scanSkills(fs: FileSystemApi): { skills: SkillBrief[]; warnings: string[] } {
  const skills: SkillBrief[] = [];
  const warnings: string[] = [];
  if (!fs.exists("/.skills")) return { skills, warnings };
  for (const entry of fs.readdir("/.skills")) {
    if (entry.type !== "directory") continue;
    const path = `/.skills/${entry.name}/SKILL.md`;
    if (!fs.exists(path)) {
      warnings.push(`Skill "${entry.name}" has no SKILL.md — skipped.`);
      continue;
    }
    const fm = parseFrontmatter(new TextDecoder().decode(fs.readFile(path)));
    if (!fm.name || !fm.description) {
      warnings.push(`Skill "${entry.name}" SKILL.md is missing name/description frontmatter — skipped.`);
      continue;
    }
    skills.push({ name: fm.name, description: fm.description, path });
  }
  return { skills, warnings };
}
