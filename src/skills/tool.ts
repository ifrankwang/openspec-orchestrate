import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import * as yaml from "js-yaml"

interface ParsedContent {
  body: string
}

function parseBody(md: string): ParsedContent {
  const result: ParsedContent = { body: md }
  if (!md.startsWith("---")) return result
  const end = md.indexOf("---", 3)
  if (end === -1) return result
  result.body = md.slice(end + 3).trim()
  return result
}

const SKILLS_ROOT = join(import.meta.dir!, "..", "..", "assets", "skills")

export function loadSkillBody(skillName: string): string {
  const skillPath = join(SKILLS_ROOT, skillName, "SKILL.md")
  if (!existsSync(skillPath)) {
    return `(bundled skill not found: ${skillName})`
  }
  const raw = readFileSync(skillPath, "utf-8")
  const { body } = parseBody(raw)
  return body
}

export function listBundledSkills(): string[] {
  if (!existsSync(SKILLS_ROOT)) return []
  const entries: string[] = []
  for (const entry of new Bun.Glob("*").scanSync({ cwd: SKILLS_ROOT })) {
    entries.push(entry)
  }
  return entries.sort()
}
