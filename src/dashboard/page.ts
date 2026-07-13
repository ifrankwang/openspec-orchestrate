import { readFileSync } from "node:fs"
import { join } from "node:path"

let _html: string | null = null

export function getDashboardPage(): string {
  if (_html) return _html
  const p = join(import.meta.dirname!, "../../assets/dashboard/index.html")
  _html = readFileSync(p, "utf-8")
  return _html
}
