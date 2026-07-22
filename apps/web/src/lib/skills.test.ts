import { describe, it, expect } from "vitest";
import { Vfs } from "@erdou/runtime-browser";
import { parseFrontmatter, scanSkills, BUILTIN_SKILLS } from "./skills.js";

describe("parseFrontmatter", () => {
  it("extracts name + description from --- fenced frontmatter", () => {
    expect(parseFrontmatter("---\nname: pptx\ndescription: Make decks\n---\nbody")).toEqual({ name: "pptx", description: "Make decks" });
  });
  it("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just a heading\nno frontmatter")).toEqual({});
  });
  it("keeps colons in the value and strips surrounding quotes", () => {
    expect(parseFrontmatter('---\nname: pdf\ndescription: "Make PDFs: reports & invoices"\n---')).toEqual({
      name: "pdf",
      description: "Make PDFs: reports & invoices",
    });
  });
});

describe("BUILTIN_SKILLS", () => {
  it("bundles the four document skills, each with a SKILL.md carrying frontmatter", () => {
    const names = BUILTIN_SKILLS.map((s) => s.name).sort();
    expect(names).toEqual(["docx", "pdf", "pptx", "xlsx"]);
    for (const s of BUILTIN_SKILLS) {
      expect(s.files["SKILL.md"]).toBeDefined();
      expect(parseFrontmatter(s.files["SKILL.md"]!).name).toBe(s.name);
    }
  });
});

describe("scanSkills", () => {
  const mk = () => new Vfs({ clock: () => 0 });

  it("returns a brief per valid skill found under /.skills", () => {
    const fs = mk();
    fs.mkdir("/.skills/pptx", { recursive: true });
    fs.writeFile("/.skills/pptx/SKILL.md", "---\nname: pptx\ndescription: Make decks\n---\nbody");
    const { skills, warnings } = scanSkills(fs);
    expect(skills).toEqual([{ name: "pptx", description: "Make decks", path: "/.skills/pptx/SKILL.md" }]);
    expect(warnings).toEqual([]);
  });

  it("skips a malformed skill (no frontmatter) with a warning and keeps the good ones", () => {
    const fs = mk();
    fs.mkdir("/.skills/good", { recursive: true });
    fs.writeFile("/.skills/good/SKILL.md", "---\nname: good\ndescription: ok\n---");
    fs.mkdir("/.skills/broken", { recursive: true });
    fs.writeFile("/.skills/broken/SKILL.md", "no frontmatter here");
    const { skills, warnings } = scanSkills(fs);
    expect(skills.map((s) => s.name)).toEqual(["good"]);
    expect(warnings.join(" ")).toMatch(/broken/);
  });

  it("returns empty (no throw) when /.skills is absent", () => {
    expect(scanSkills(mk())).toEqual({ skills: [], warnings: [] });
  });
});
