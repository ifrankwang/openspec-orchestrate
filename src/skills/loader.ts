import { existsSync } from "node:fs"
import { join } from "node:path"

const SKILLS_ROOT = join(import.meta.dir!, "..", "..", "assets", "skills")

export function injectSkills(config: Record<string, unknown>): void {
  if (!existsSync(SKILLS_ROOT)) return

  const skillsCfg = (config.skills ?? {}) as Record<string, unknown>
  const paths = (skillsCfg.paths ?? []) as string[]
  if (!paths.includes(SKILLS_ROOT)) {
    paths.push(SKILLS_ROOT)
  }
  skillsCfg.paths = paths
  config.skills = skillsCfg
}
