import { tool } from "@opencode-ai/plugin"
import path from "path"
import { mkdirSync } from "node:fs"

// ─── GitRunner 注入点（测试用 fake-git） ───

export interface GitRunner {
  run(worktree: string, args: string[]): Promise<string>
  runChecked(
    worktree: string,
    args: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string }>
}

const defaultRunner: GitRunner = {
  async run(worktree, args) {
    try {
      const proc = Bun.spawn(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out.trim()
    } catch {
      return ""
    }
  },
  async runChecked(worktree, args) {
    const proc = Bun.spawn(["git", "-C", worktree, ...args], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { success: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() }
  },
}

let gitRunner: GitRunner = defaultRunner

export function __setGitRunner(r: GitRunner | null): void {
  gitRunner = r ?? defaultRunner
}

// ─── 常量 ───

const STATE_DIR_NAME = ".opencode"
const STATE_SUBDIR_NAME = ".orchestrate_state"
const MAX_RETRIES = 3
const SEVERITY_LEVELS = ["Critical", "High", "Medium", "Low", "Info"] as const
const BLOCKING_SEVERITIES = ["Critical", "High", "Medium", "Low"] as const

// dimension 7 维，统一英文枚举
const TASK_DIM = "task"
const CODE_DIMENSIONS = ["style", "architecture", "performance", "security", "maintainability"] as const
const TEST_DIM = "test"
const ALL_DIMENSIONS = [TASK_DIM, ...CODE_DIMENSIONS, TEST_DIM] as const
type Dimension = typeof ALL_DIMENSIONS[number]
const REVIEW_DIMENSIONS = [...CODE_DIMENSIONS, TEST_DIM] as const
type ReviewDimension = typeof REVIEW_DIMENSIONS[number]
type CodeDimension = typeof CODE_DIMENSIONS[number]

// ─── Zod Schema ───

const architectIssue = tool.schema.object({
  file: tool.schema.string().min(1).describe("问题所在文件路径（相对于 worktree）"),
  line: tool.schema.number().int().positive().describe("问题所在行号"),
  type: tool.schema.enum(["不一致", "缺失", "冲突", "模糊", "其他"]).describe("问题类型（文档一致性问题分类）"),
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别（Critical/High/Medium/Low/Info）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema.string().optional().describe("修改建议"),
})

const executionBoundarySchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能修改/创建文件的目录列表"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能新增/修改代码的包路径列表"),
  notes: tool.schema.string().describe("实施建议：关键坑位提醒、组件复用指引、设计约束边缘场景、框架应用说明（如 MapStruct 对象转换）；不含目录/包路径（见 allowed_directories/allowed_packages），无则留空"),
})

const TEST_ISSUE_TYPES = ["断言放水", "边界缺失", "Mock过度", "覆盖不足", "其他"] as const

const reviewIssue = tool.schema.object({
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别（Critical/High/Medium/Low/Info）"),
  file: tool.schema.string().min(1).describe("问题所在文件路径（相对于 worktree）"),
  line: tool.schema.number().int().positive().describe("问题所在行号"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema
    .string()
    .optional()
    .describe("修复建议"),
  type: tool.schema
    .enum(TEST_ISSUE_TYPES)
    .optional()
    .describe("问题类型（dimension=test 必填：断言放水/边界缺失/Mock过度/覆盖不足/其他）"),
  root_cause_guess: tool.schema
    .string()
    .optional()
    .describe("根因猜测（dimension=test 必填，不可为空）"),
})

// ─── 状态类型 ───

type Phase = "architect_review" | "developer_implement" | "review" | "completed"
/** buildPhases 的有效目标阶段（不含 "completed"） */
type BuildPhaseTarget = "architect_review" | "developer_implement" | "review"
type OrchestrateStatus = "not_started" | "in_progress" | "completed"

interface ExecutionBoundary {
  allowed_directories: string[]
  allowed_packages: string[]
  notes: string
}

const TASK_STATUSES = ["open", "submitted", "rejected", "verified", "skipped"] as const
type TaskStatus = typeof TASK_STATUSES[number]
const ISSUE_STATUSES = ["open", "submitted", "rejected", "verified", "exemption", "exempted"] as const
type IssueStatus = typeof ISSUE_STATUSES[number]

interface TaskItem {
  id: string
  tasksMdRef: string
  specTrace: string
  title: string
  status: TaskStatus
  taskNumber: string
}

interface IssueItem {
  id: string
  dimension: Dimension
  severity: string
  file: string
  line: number
  description: string
  suggestion: string
  status: IssueStatus
  firstRound: number
  // test 维度专用
  type: string | null
  rootCauseGuess: string | null
  // 豁免理由（仅 exemption 状态时有效）
  exemptReason: string | null
}

interface DimensionProgress {
  submitted: boolean
  passed: boolean
}

type ReviewProgress = Record<ReviewDimension, DimensionProgress>

interface DevPhaseData {
  completed: boolean
  tasks: TaskItem[]
  issues: IssueItem[]
}

function deriveDevStatus(dp: DevPhaseData): "developing" | "validating" {
  const allDone = dp.tasks.every(
    (t) => t.status === "skipped" || t.status === "verified" || t.status === "submitted"
  )
  return allDone ? "validating" : "developing"
}

interface ReviewPhaseData {
  completed: boolean
  retryCount: number
  progress: ReviewProgress
  issues: IssueItem[]
}

interface SimplePhaseData {
  completed: boolean
}

interface Phases {
  architect_review: SimplePhaseData
  developer_implement: DevPhaseData
  review: ReviewPhaseData
}

interface TaskGroupState {
  id: string
  name: string
  taskCount: number
  worktreePath: string | null
  branchName: string | null
  baseRef: string | null
  executionBoundary: ExecutionBoundary | null
  relevantSpecs: string[]
  lastFilesChanged: string[]
  status: Phase
  phases: Phases
}

interface OrchestrateState {
  changeId: string
  currentTaskGroupId: string
  baseBranch: string
  taskGroups: TaskGroupState[]
  createdAt: string
  updatedAt: string
}

// ─── 辅助函数 ───

function createEmptyPhases(): Phases {
  return {
    architect_review: { completed: false },
    developer_implement: { completed: false, tasks: [], issues: [] },
    review: { completed: false, retryCount: 0, progress: createEmptyReviewProgress(), issues: [] },
  }
}

function createEmptyReviewProgress(): ReviewProgress {
  return {
    style: { submitted: false, passed: false },
    architecture: { submitted: false, passed: false },
    performance: { submitted: false, passed: false },
    security: { submitted: false, passed: false },
    maintainability: { submitted: false, passed: false },
    test: { submitted: false, passed: false },
  }
}

/** 从 status 派生组级生命状态（替换已删除的 status 字段） */
function deriveStatus(tg: TaskGroupState, currentTaskGroupId: string): OrchestrateStatus {
  if (tg.status === "completed") return "completed"
  if (tg.status === "architect_review" && tg.id !== currentTaskGroupId && phasesAllEmpty(tg)) return "not_started"
  return "in_progress"
}

function phasesAllEmpty(tg: TaskGroupState): boolean {
  return !tg.phases.architect_review.completed
    && !tg.phases.developer_implement.completed
    && tg.phases.developer_implement.tasks.every((t) => t.status === "open")
    && !tg.phases.review.completed
    && tg.phases.review.issues.length === 0
    && tg.phases.review.retryCount === 0
}

function hasBlockingIssues(issues: Array<{ severity: string }>): boolean {
  return issues.some((i) => (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity))
}

// 单条 issue 是否为阻塞级（Low 及以上；Info 不阻塞）
function isBlockingIssue(i: { severity: string }): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
}

// 存在待确认修复（submitted）issue 的维度集
function dimsWithSubmittedIssue(tg: TaskGroupState): Set<string> {
  const dims = new Set<string>()
  for (const i of tg.phases.review.issues) {
    if (i.status === "submitted") dims.add(i.dimension)
  }
  return dims
}

// 派生本轮需审查的维度集（不持久化）：
// 首轮（retryCount===0）全部维度建基线；修复轮仅含存在 submitted issue 的维度。
function computeRequiredDims(tg: TaskGroupState): ReviewDimension[] {
  const all = [...REVIEW_DIMENSIONS] as ReviewDimension[]
  if (tg.phases.review.retryCount === 0) return all
  const dims = dimsWithSubmittedIssue(tg)
  return all.filter((d) => dims.has(d))
}

// ─── 调用者身份校验 ───

const ORCHESTRATOR_AGENT = "openspec-orchestrator"

function assertOrchestrator(context: { agent: string }, toolName: string): void {
  if (context.agent !== ORCHESTRATOR_AGENT) {
    throw new Error(
      `工具 "${toolName}" 仅限编排者 "${ORCHESTRATOR_AGENT}" 调用，当前调用者为 "${context.agent}"。`
    )
  }
}

function assertAgent(context: { agent: string }, toolName: string, allowedAgents: string[]): void {
  if (!allowedAgents.includes(context.agent)) {
    throw new Error(`工具 "${toolName}" 仅限 [${allowedAgents.join(", ")}] 调用，当前调用者为 "${context.agent}"。`)
  }
}

// 每个维度对应唯一 reviewer agent
const DIMENSION_AGENT_MAP: Record<Dimension, string> = {
  task: "openspec-validator",
  style: "openspec-reviewer-style",
  architecture: "openspec-reviewer-architecture",
  performance: "openspec-reviewer-performance",
  security: "openspec-reviewer-security",
  maintainability: "openspec-reviewer-maintainability",
  test: "openspec-reviewer-test",
}

// ─── tasks.md 解析 ───

interface ParsedTask {
  title: string
  specTrace: string
  tasksMdRef: string
  taskNumber: string
}

function parseSpecTrace(line: string): string {
  const m = line.match(/\[spec:([^\]]+)\]/)
  return m ? m[1].trim() : ""
}

async function parseTasksMdForGroup(
  worktree: string,
  changeId: string,
  taskGroupId: string
): Promise<ParsedTask[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  const tasks: ParsedTask[] = []
  try {
    const f = Bun.file(tasksPath)
    if (!(await f.exists())) return tasks
    const content = await f.text()
    const lines = content.split("\n")
    let currentGroup: string | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const groupMatch = line.match(/^##\s+(\d+)\./)
      if (groupMatch) {
        if (currentGroup === taskGroupId) break
        currentGroup = groupMatch[1]
        continue
      }
      if (currentGroup !== taskGroupId) continue
      const taskMatch = line.match(/^-\s+\[[\sx]\]\s+(.+)/)
      if (taskMatch) {
        const body = taskMatch[1]
        const taskNumberMatch = body.match(/^(\d+(?:\.\d+)+)\s+/)
        const taskNumber = taskNumberMatch ? taskNumberMatch[1] : ""
        const cleaned = (taskNumberMatch ? body.slice(taskNumberMatch[0].length) : body)
          .replace(/\s*\[spec:[^\]]+\]\s*$/, "")
          .trim()
        const specTrace = parseSpecTrace(body)
        tasks.push({ title: cleaned, specTrace, tasksMdRef: `line-${i + 1}`, taskNumber })
      }
    }
  } catch {
    // ignore
  }
  return tasks
}

function extractRelevantSpecsFromTasks(tasks: ParsedTask[]): string[] {
  const set = new Set<string>()
  for (const t of tasks) {
    if (!t.specTrace) continue
    const parts = t.specTrace.split("#")[0]
    if (parts) set.add(parts)
  }
  return Array.from(set)
}

async function parseAllTaskGroupsFromMd(
  worktree: string,
  changeId: string
): Promise<{ id: string; name: string; taskCount: number }[]> {
  const tasksPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  const groups: { id: string; name: string; taskCount: number }[] = []
  try {
    const f = Bun.file(tasksPath)
    if (!(await f.exists())) return groups
    const content = await f.text()
    const lines = content.split("\n")
    let currentGroup: { id: string; name: string } | null = null
    let currentTaskCount = 0
    for (const line of lines) {
      const groupMatch = line.match(/^##\s+(\d+)\./)
      if (groupMatch) {
        if (currentGroup) groups.push({ ...currentGroup, taskCount: currentTaskCount })
        currentGroup = { id: groupMatch[1], name: line.replace(/^##\s+\d+\.\s*/, "").trim() }
        currentTaskCount = 0
        continue
      }
      if (currentGroup) {
        if (/^-\s+\[[\sx]\]\s+/.test(line)) currentTaskCount++
      }
    }
    if (currentGroup) groups.push({ ...currentGroup, taskCount: currentTaskCount })
  } catch {
    // ignore
  }
  return groups
}

// ─── state 文件操作 ───
//
// 设计：state 按 changeId 拆分多文件（`.opencode/.orchestrate_state/<change_id>.json`）。
// 通过 `current.json` 指针文件记录当前活跃 changeId，所有工具通过 worktree 加载指针
// 解析 changeId 后再加载对应 state。同一 worktree 任意时刻仅有一个活跃 change。

function getStateDir(worktree: string): string {
  return path.join(worktree, STATE_DIR_NAME, STATE_SUBDIR_NAME)
}

function getStatePath(worktree: string, changeId: string): string {
  return path.join(getStateDir(worktree), `${changeId}.json`)
}

function getCurrentPointerPath(worktree: string): string {
  return path.join(getStateDir(worktree), "current.json")
}

async function readCurrentChangeId(worktree: string): Promise<string> {
  const fp = getCurrentPointerPath(worktree)
  try {
    const f = Bun.file(fp)
    if (await f.exists()) {
      const data = (await f.json()) as { changeId: string }
      return data.changeId || ""
    }
  } catch {
    // ignore
  }
  return ""
}

async function writeCurrentChangeId(worktree: string, changeId: string): Promise<void> {
  mkdirSync(getStateDir(worktree), { recursive: true })
  await Bun.write(getCurrentPointerPath(worktree), JSON.stringify({ changeId }, null, 2))
}

async function readStateByWorktree(worktree: string): Promise<OrchestrateState | null> {
  const changeId = await readCurrentChangeId(worktree)
  if (!changeId) return null
  return readStateByChangeId(worktree, changeId)
}

async function readStateByChangeId(worktree: string, changeId: string): Promise<OrchestrateState | null> {
  const fp = getStatePath(worktree, changeId)
  try {
    const f = Bun.file(fp)
    if (await f.exists()) {
      const state = (await f.json()) as OrchestrateState
      return state
    }
  } catch {
    // 文件不存在或解析失败
  }
  return null
}

async function writeState(worktree: string, state: OrchestrateState): Promise<void> {
  mkdirSync(getStateDir(worktree), { recursive: true })
  await writeCurrentChangeId(worktree, state.changeId)
  state.updatedAt = new Date().toISOString()
  await Bun.write(getStatePath(worktree, state.changeId), JSON.stringify(state, null, 2))
}

// ─── git 辅助 ───

async function runGit(worktree: string, args: string[]): Promise<string> {
  return gitRunner.run(worktree, args)
}

async function getCurrentHead(worktree: string): Promise<string> {
  return runGit(worktree, ["rev-parse", "HEAD"])
}

async function getMergeBase(worktree: string, baseBranch: string): Promise<string> {
  return runGit(worktree, ["merge-base", "HEAD", baseBranch])
}

async function getDiffFileList(worktree: string, baseRef: string): Promise<string[]> {
  const out = await runGit(worktree, ["diff", "--name-only", `${baseRef}..HEAD`])
  if (!out) return []
  return out.split("\n").map((s) => s.trim()).filter(Boolean)
}

async function isWorktreeClean(worktree: string): Promise<boolean> {
  const out = await runGit(worktree, ["status", "--porcelain"])
  return out.length === 0
}

// 带退出码检查的 git 调用（不吞错）
async function runGitChecked(
  worktree: string,
  args: string[]
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  return gitRunner.runChecked(worktree, args)
}

// 回写 tasks.md：将已 verified task 所在行的 [ ] 改为 [x]，并 commmit
async function updateTasksMdForVerifiedTasks(
  worktree: string,
  changeId: string,
  tasks: TaskItem[],
  verifiedIds: string[]
): Promise<void> {
  if (verifiedIds.length === 0) return
  const tasksMdPath = path.join(worktree, "openspec", "changes", changeId, "tasks.md")
  const f = Bun.file(tasksMdPath)
  if (!(await f.exists())) return
  const content = await f.text()
  const lines = content.split("\n")
  let modified = false
  for (const id of verifiedIds) {
    const task = tasks.find((t) => t.id === id)
    if (!task || !task.tasksMdRef) continue
    const lineMatch = task.tasksMdRef.match(/^line-(\d+)$/)
    if (!lineMatch) continue
    const lineNum = parseInt(lineMatch[1], 10) - 1
    if (lineNum < 0 || lineNum >= lines.length) continue
    if (/^-\s+\[\s\]\s+/.test(lines[lineNum])) {
      lines[lineNum] = lines[lineNum].replace(/^(-\s+)\[\s\](\s+)/, "$1[x]$2")
      modified = true
    }
  }
  if (!modified) return
  await Bun.write(tasksMdPath, lines.join("\n"))
  const addResult = await runGitChecked(worktree, ["add", tasksMdPath])
  if (!addResult.success) {
    throw new Error(`git add tasks.md 失败：${addResult.stderr}`)
  }
  const commitResult = await runGitChecked(worktree, ["commit", "-m", "docs(tasks): mark verified task checkboxes"])
  if (!commitResult.success) {
    throw new Error(`git commit tasks.md 失败：${commitResult.stderr}`)
  }
}

// 合并分支到目标。冲突时 abort + 返回失败信号，不清理 worktree/分支。
async function mergeBranchToTarget(
  worktree: string,
  sourceBranch: string,
  targetBranch: string
): Promise<{ success: boolean; conflict: boolean }> {
  const checkoutResult = await runGitChecked(worktree, ["checkout", targetBranch])
  if (!checkoutResult.success) {
    throw new Error(`无法切到目标分支 "${targetBranch}"：${checkoutResult.stderr}`)
  }
  const mergeResult = await runGitChecked(worktree, ["merge", "--no-ff", sourceBranch])
  if (!mergeResult.success) {
    await runGitChecked(worktree, ["merge", "--abort"])
    return { success: false, conflict: true }
  }
  return { success: true, conflict: false }
}

// ─── 严重级别校验 ───

function assertPassWithIssues(passed: boolean, issues: Array<{ severity: string }>, toolName: string): void {
  if (passed && hasBlockingIssues(issues)) {
    throw new Error(
      `工具 "${toolName}"：报告声称 passed=true，但 issues 中包含 Low 及以上严重级别的问题，仅有 Info 级别问题可以通过。`
    )
  }
}

// ─── opx_status 按角色路由返回内容 ───

function findTaskGroup(state: OrchestrateState, id: string): TaskGroupState {
  const tg = state.taskGroups.find((g) => g.id === id)
  if (!tg) throw new Error(`任务组 "${id}" 不在任务清单中。`)
  return tg
}

/** task 状态汇总计数。skipped 仅用于 task 维度（组级 skipped 已移除）。 */
function taskSummary(tasks: TaskItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0, skipped: 0 }
  for (const t of tasks) counts[t.status]++
  return counts
}

function issueSummary(issues: IssueItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0, exemption: 0, exempted: 0 }
  for (const i of issues) counts[i.status]++
  return counts
}

function renderTaskItem(t: TaskItem): string {
  const trace = t.specTrace ? ` [spec:${t.specTrace}]` : ""
  const num = t.taskNumber ? `（tasks.md ${t.taskNumber}）` : ""
  return `- Task id=${t.id}${num} ｜ ${t.title}${trace}`
}

function renderIssueItem(i: IssueItem): string {
  const lines: string[] = []
  lines.push(`- Issue #${i.id} | ${i.severity} | ${i.dimension}`)
  lines.push(`  - 文件：${i.file}:${i.line}`)
  lines.push(`  - 描述：${i.description}`)
  if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
  if (i.status === "exemption" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  lines.push(`  - 首次报告轮次：${i.firstRound}`)
  return lines.join("\n")
}

function renderOrchestratorView(state: OrchestrateState, tg: TaskGroupState, diskWorktrees?: { branch: string; path: string }[]): string {
  const ts = taskSummary(tg.phases.developer_implement.tasks)
  const is = issueSummary(tg.phases.review.issues)
  const lines: string[] = []
  lines.push("# 编排进度", "")
  lines.push(`**变更**: ${state.changeId}`)
  lines.push(`**任务组**: ${tg.id} — ${tg.name}`)
  lines.push(`**当前阶段**: ${tg.status}`, "")
  lines.push("## 阶段进展", "")
  lines.push("| 阶段 | 状态 |")
  lines.push("|------|------|")
  const phaseSummary = (name: string, p: { completed: boolean }) => p.completed ? "✓" : (tg.status === name ? "●" : "✗")
  lines.push(`| architect_review | ${phaseSummary("architect_review", tg.phases.architect_review)} |`)
  const devStatus = tg.phases.developer_implement.completed ? "✓" : (tg.status === "developer_implement" ? `● ${deriveDevStatus(tg.phases.developer_implement)}` : "✗")
  lines.push(`| developer_implement | ${devStatus} |`)
  const reviewStatus = tg.phases.review.completed ? "✓" : (tg.status === "review" ? `● round ${tg.phases.review.retryCount + 1}/3` : "✗")
  lines.push(`| review | ${reviewStatus} |`)
  lines.push("")
  lines.push("## Task 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${ts.open} |`)
  lines.push(`| submitted | ${ts.submitted} |`)
  lines.push(`| rejected | ${ts.rejected} |`)
  lines.push(`| verified | ${ts.verified} |`)
  lines.push(`| skipped | ${ts.skipped} |`)
  lines.push("")
  const p2is = issueSummary(tg.phases.developer_implement.issues)
  const hasP2Issues = Object.values(p2is).some((c) => c > 0)
  if (hasP2Issues) {
    lines.push("## Phase 2 Issue 摘要", "")
    lines.push(`| 状态 | 数量 |`)
    lines.push(`|------|------|`)
    lines.push(`| open | ${p2is.open} |`)
    lines.push(`| submitted | ${p2is.submitted} |`)
    lines.push(`| rejected | ${p2is.rejected} |`)
    lines.push(`| verified | ${p2is.verified} |`)
    lines.push(`| exemption | ${p2is.exemption} |`)
    lines.push(`| exempted | ${p2is.exempted} |`)
    lines.push("")
  }
  lines.push("## Issue 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${is.open} |`)
  lines.push(`| submitted | ${is.submitted} |`)
  lines.push(`| rejected | ${is.rejected} |`)
  lines.push(`| verified | ${is.verified} |`)
  lines.push(`| exemption | ${is.exemption} |`)
  lines.push(`| exempted | ${is.exempted} |`)
  lines.push("")
  lines.push("## 审核进度", "")
  const rp = tg.phases.review.progress
  const fmt = (k: ReviewDimension) => `${k}=${rp[k].submitted ? (rp[k].passed ? "passed" : "rejected") : "not_submitted"}`
  lines.push(`| 维度 | 状态 |`)
  lines.push(`|------|------|`)
  for (const dim of ["style", "architecture", "performance", "security", "maintainability", "test"] as const) {
    lines.push(`| ${dim} | ${fmt(dim)} |`)
  }
  if (diskWorktrees && diskWorktrees.length > 0) {
    const stateBranches = new Set(state.taskGroups.filter((g) => g.branchName).map((g) => g.branchName!))
    const unregistered = diskWorktrees.filter((w) => !stateBranches.has(w.branch))
    lines.push("")
    lines.push("## 磁盘 Worktree", "")
    lines.push("| 分支 | 路径 | 状态 |")
    lines.push("|------|------|------|")
    for (const w of diskWorktrees) {
      const registered = stateBranches.has(w.branch)
      const existingTg = state.taskGroups.find((g) => g.branchName === w.branch)
      const derivedStatus = existingTg ? deriveStatus(existingTg, state.currentTaskGroupId) : "completed"
      const status = registered ? `已注册 (TG${existingTg?.id}, ${derivedStatus})` : "未注册（可恢复进度）"
      lines.push(`| ${w.branch} | \`${w.path}\` | ${status} |`)
    }
    if (unregistered.length > 0) {
      lines.push("")
      lines.push(`⚠️ 发现 ${unregistered.length} 个未注册到状态文件的 worktree，请用 question 询问用户是否恢复，确认后调用 opx_orch_init(recovery=...) 恢复。`)
      for (const w of unregistered) {
        const match = w.branch.match(/^task-group\/(\d+)$/)
        const tgId = match ? match[1] : "?"
        lines.push(`  - ${w.branch} → \`opx_orch_init({ recovery: { phase: "<phase>", worktree_path: "${w.path}", branch_name: "${w.branch}" } })\``)
      }
    }
  }
  // ── 一致性分析 ──
  lines.push("")
  lines.push("## 一致性分析", "")
  const checks: string[] = []
  // 规则 1：阶段逆序
  if (tg.phases.developer_implement.completed && tg.status === "architect_review") {
    checks.push(`- ⚠️ 阶段逆序：status=architect_review 但 developer_implement.completed=true`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "developer_implement", ... } })\``)
  }
  if (tg.phases.review.completed && tg.status !== "review" && tg.status !== "completed") {
    checks.push(`- ⚠️ 阶段逆序：status=${tg.status} 但 review.completed=true`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "review", ... } })\``)
  }
  // 规则 2：缺 worktree
  if ((tg.status === "developer_implement" || tg.status === "review") && !tg.worktreePath) {
    checks.push(`- ⚠️ 缺 worktree：status=${tg.status} 但 worktreePath=null`)
    checks.push(`  建议：先调 opx_orch_set_worktree 创建 worktree，或 \`opx_orch_init({ recovery: { phase: "${tg.status}", worktree_path: "<path>", branch_name: "task-group/${tg.id}" } })\``)
  }
  // 规则 3：缺 executionBoundary
  if ((tg.status === "developer_implement" || tg.status === "review") && !tg.executionBoundary) {
    checks.push(`- ⚠️ 缺 executionBoundary：status=${tg.status} 但 executionBoundary=null`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "architect_review", ... } })\``)
  }
  // 规则 4：review 内部——维度 passed 但仍有该维度阻塞 issue
  for (const dim of REVIEW_DIMENSIONS) {
    const p = tg.phases.review.progress[dim]
    if (p.passed) {
      const openInDim = tg.phases.review.issues.filter(
        (i) => i.dimension === dim && (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
      )
      if (openInDim.length > 0) {
        checks.push(`- ⚠️ review 内部矛盾：维度 ${dim} passed 但仍有 ${openInDim.length} 个阻塞 issue`)
        checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "${tg.status === "completed" ? "review" : tg.status}", ... } })\``)
      }
    }
  }
  if (checks.length > 0) {
    lines.push(...checks)
    lines.push("")
    lines.push("请用 question 向用户展示上述异常，确认后按对应建议调用 opx_orch_init(recovery=...) 修复。")
  } else {
    lines.push("未发现状态异常。")
  }
  return lines.join("\n")
}

async function discoverDiskWorktrees(worktree: string): Promise<{ branch: string; path: string }[]> {
  const result: { branch: string; path: string }[] = []
  const wtList = await runGit(worktree, ["worktree", "list"])
  for (const line of wtList.split("\n")) {
    const m = line.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
    if (m) {
      const branch = m[2].trim()
      if (branch.startsWith("task-group/")) {
        result.push({ branch, path: m[1].trim() })
      }
    }
  }
  return result
}

function renderArchitectView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 架构师上下文", "")
  lines.push(`**变更**: ${state.changeId}`)
  lines.push(`**任务组**: ${tg.id} — ${tg.name}`)
  lines.push(`**当前阶段**: ${tg.status}`, "")
  lines.push("## 相关 spec 文件", "")
  if (tg.relevantSpecs.length === 0) {
    lines.push("- (无)")
  } else {
    for (const s of tg.relevantSpecs) {
      lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
    }
  }
  lines.push("")
  lines.push("## Task (open)", "")
  const open = tg.phases.developer_implement.tasks.filter((t) => t.status === "open")
  if (open.length === 0) lines.push("- (无)")
  else for (const t of open) lines.push(renderTaskItem(t))
  lines.push("")
  lines.push("## Issue (申请豁免中)", "")
  const exemption = tg.phases.review.issues.filter((i) => i.status === "exemption")
  if (exemption.length === 0) lines.push("- (无)")
  else for (const i of exemption) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## Issue (open)", "")
  const openIssues = tg.phases.review.issues.filter((i) => i.status === "open")
  if (openIssues.length === 0) lines.push("- (无)")
  else for (const i of openIssues) lines.push(renderIssueItem(i))
  return lines.join("\n")
}

function renderDeveloperView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  const inReview = tg.status === "review"
  const devStatus = deriveDevStatus(tg.phases.developer_implement)
  lines.push("# 开发上下文", "")
  lines.push(`**任务组**: ${tg.id} — ${tg.name}`)
  if (inReview) lines.push("**角色**: fixer（修复 issue）")
  else lines.push(`**角色**: task 实施 · ${devStatus === "validating" ? "等待 validator" : "开发中"}`, "")
  lines.push("")
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **diff 范围**: \`${tg.baseRef}..HEAD\``)
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push("")
  lines.push("## 执行边界", "")
  if (tg.executionBoundary) {
    const b = tg.executionBoundary
    lines.push("- **允许目录**:")
    for (const d of b.allowed_directories) lines.push(`  - \`${d}\``)
    lines.push("- **允许包**:")
    for (const p of b.allowed_packages) lines.push(`  - \`${p}\``)
    if (b.notes) lines.push(`- **实施前请注意遵守**: ${b.notes}`)
  } else {
    lines.push("- (无)")
  }
  lines.push("")
  lines.push("## 相关 spec 文件", "")
  if (tg.relevantSpecs.length === 0) lines.push("- (无)")
  else for (const s of tg.relevantSpecs) lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
  lines.push("")

  if (!inReview) {
    lines.push("## Task (待完成)", "")
    const openTasks = tg.phases.developer_implement.tasks.filter((t) => t.status === "open")
    if (openTasks.length === 0) lines.push("- (无)")
    else for (const t of openTasks) lines.push(renderTaskItem(t))
    lines.push("")
    lines.push("## Task (待验证)", "")
    const submitted = tg.phases.developer_implement.tasks.filter((t) => t.status === "submitted")
    if (submitted.length === 0) lines.push("- (无)")
    else for (const t of submitted) lines.push(renderTaskItem(t))
    lines.push("")
    lines.push("## Task (已驳回)", "")
    const rejected = tg.phases.developer_implement.tasks.filter((t) => t.status === "rejected")
    if (rejected.length === 0) lines.push("- (无)")
    else for (const t of rejected) lines.push(renderTaskItem(t))
    lines.push("")
    lines.push("## Issue (待修复 · Low 及以上)", "")
    const blockingPhase2 = tg.phases.developer_implement.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
    )
    if (blockingPhase2.length === 0) lines.push("- (无)")
    else for (const i of blockingPhase2) lines.push(renderIssueItem(i))
    lines.push("")
    lines.push("## Issue (已修复待验证)", "")
    const submittedPhase2 = tg.phases.developer_implement.issues.filter((i) => i.status === "submitted")
    if (submittedPhase2.length === 0) lines.push("- (无)")
    else for (const i of submittedPhase2) lines.push(renderIssueItem(i))
    lines.push("")
    lines.push("## Issue (豁免裁定中)", "")
    const exemptionPhase2 = tg.phases.developer_implement.issues.filter((i) => i.status === "exemption")
    if (exemptionPhase2.length === 0) lines.push("- (无)")
    else for (const i of exemptionPhase2) lines.push(renderIssueItem(i))
  } else {
    lines.push("## Issue (待修复 · Low 及以上，必办)", "")
    const toFix = tg.phases.review.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
    )
    if (toFix.length === 0) lines.push("- (无)")
    else for (const i of toFix) lines.push(renderIssueItem(i))
    lines.push("")
    lines.push("## Issue (待修复 · Info，可选，不阻塞提交)", "")
    const infoFix = tg.phases.review.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && !isBlockingIssue(i)
    )
    if (infoFix.length === 0) lines.push("- (无)")
    else for (const i of infoFix) lines.push(renderIssueItem(i))
    lines.push("")
    lines.push("## Issue (豁免裁定中)", "")
    const exemption = tg.phases.review.issues.filter((i) => i.status === "exemption")
    if (exemption.length === 0) lines.push("- (无)")
    else for (const i of exemption) lines.push(renderIssueItem(i))
  }
  return lines.join("\n")
}

function renderReviewerView(state: OrchestrateState, tg: TaskGroupState, agent: string): string {
  const dimension = (Object.keys(DIMENSION_AGENT_MAP) as Dimension[]).find((d) => DIMENSION_AGENT_MAP[d] === agent)
  const lines: string[] = []
  lines.push(`# 审核上下文 — ${dimension || "?"}`, "")
  lines.push(`**任务组**: ${tg.id} — ${tg.name}`, "")
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **diff 范围**: \`${tg.baseRef}..HEAD\``)
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push("")
  if (dimension !== TASK_DIM) {
    lines.push("## 上轮变更文件", "")
    if (tg.lastFilesChanged.length === 0) lines.push("- (无)")
    else for (const f of tg.lastFilesChanged) lines.push(`- \`${f}\``)
    lines.push("")
    lines.push(
      "> 回归排查：对照上述「上轮变更文件」，检查本次修复是否在本维度引入了新问题；发现即在本维度报新 issue。",
      ""
    )
  }
  if (dimension === TASK_DIM) {
    lines.push("## Task (open)", "")
    const open = tg.phases.developer_implement.tasks.filter((t) => t.status === "open")
    if (open.length === 0) lines.push("- (无)")
    else for (const t of open) lines.push(renderTaskItem(t))
    lines.push("")
    lines.push(
      "> ⚠️ `verified_task_ids`/`failed_task_ids` 必须填 Task id 列（`id=` 后的数字），**不是** tasks.md 编号。填错 id 会导致验证失败，工具将按非法 id 报错。",
      ""
    )
  } else {
    const same = tg.phases.review.issues.filter((i) => i.dimension === dimension && i.status === "open")
    lines.push("## 本维度 Issue (open)", "")
    if (same.length === 0) lines.push("- (无)")
    else for (const i of same) lines.push(renderIssueItem(i))
    lines.push("")
    const submitted = tg.phases.review.issues.filter((i) => i.dimension === dimension && i.status === "submitted")
    lines.push("## 本维度 Issue (待确认)", "")
    if (submitted.length === 0) lines.push("- (无)")
    else for (const i of submitted) lines.push(renderIssueItem(i))
    lines.push("")
    lines.push(
      "> 存量确认：逐条核验上述「待确认」issue 是否真已修复——已修复列入 fixed_issue_ids；未达标则不列入，工具将自动回退为 rejected 交 developer 重修。",
      ""
    )
    const exemption = tg.phases.review.issues.filter((i) => i.dimension === dimension && i.status === "exemption")
    lines.push("## 本维度 Issue (豁免裁定中)", "")
    if (exemption.length === 0) lines.push("- (无)")
    else for (const i of exemption) lines.push(renderIssueItem(i))
  }
  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_init
// ═══════════════════════════════════════════════════════════

const PHASE_ORDER: Phase[] = ["architect_review", "developer_implement", "review"]

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和当前任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析当前组子任务。可通过 recovery 参数恢复到指定阶段。同 changeId 可重复调用，仅重建当前组，其余组原样保留。",
  args: {
    change_id: tool.schema.string().min(1).describe("OpenSpec 变更 ID"),
    current_task_group_id: tool.schema.string().min(1).describe("当前要初始化的任务组 ID。仅此组被重建（in_progress），其余组原样保留。首次初始化时当前组之前的组为 not_started。"),
    base_branch: tool.schema.string().default("main").optional().describe("基准分支名（如 main、master），用于计算 merge-base 和 worktree fork 源。默认 main。"),
    recovery: tool.schema.object({
      phase: tool.schema.enum(PHASE_ORDER).describe("恢复到哪个阶段"),
      worktree_path: tool.schema.string().min(1).describe("已有 worktree 的绝对路径"),
      branch_name: tool.schema.string().min(1).describe("worktree 对应的分支名（如 task-group/3）"),
      preserve_progress: tool.schema.boolean().default(true).optional().describe("是否保留阶段内进度（task/issue 状态）。true 时只修阶段错位、不动阶段内明细；false 时按 phase 重置全部 task/issue 进度。默认 true。"),
    }).optional().describe("进度恢复参数。提供后按 phase 恢复阶段状态，< phase 为 completed，== phase 为 in_progress，> phase 为 not_started。"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_init")

    const parsedGroups = await parseAllTaskGroupsFromMd(context.worktree, args.change_id)
    if (parsedGroups.length === 0) {
      throw new Error(`无法从 tasks.md 解析出任务组，请检查文件 openspec/changes/${args.change_id}/tasks.md。`)
    }
    const targetGroup = parsedGroups.find((g) => g.id === args.current_task_group_id)
    if (!targetGroup) {
      throw new Error(`current_task_group_id "${args.current_task_group_id}" 不在 tasks.md 中。可用 ID: [${parsedGroups.map((g) => g.id).join(", ")}]。`)
    }

    // 解析当前任务组的子任务
    const parsedTasks = await parseTasksMdForGroup(context.worktree, args.change_id, args.current_task_group_id)
    const relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
    const newTasks: TaskItem[] = parsedTasks.map((p, i) => ({
      id: String(i + 1),
      tasksMdRef: p.tasksMdRef,
      specTrace: p.specTrace,
      title: p.title,
      status: "open" as const,
      taskNumber: p.taskNumber,
    }))

    function buildPhases(targetPhase: BuildPhaseTarget | null): { phases: Phases; status: BuildPhaseTarget } {
      if (!targetPhase) return { phases: createEmptyPhases(), status: "architect_review" }
      const phases = createEmptyPhases()
      let found = false
      for (const p of PHASE_ORDER) {
        if (p === targetPhase) { found = true; continue }
        if (!found) {
          phases[p] = p === "developer_implement"
            ? { completed: true, tasks: [], issues: [] }
            : p === "review"
            ? { completed: true, retryCount: 0, progress: createEmptyReviewProgress(), issues: [] }
            : { completed: true }
        }
      }
      return { phases, status: targetPhase }
    }

    const taskInjectionStatus: TaskStatus = args.recovery?.phase === "review" ? "verified" : "open"

    let state = await readStateByChangeId(context.worktree, args.change_id)
    const baseBranch = args.base_branch || "main"
    if (state) {
      state.baseBranch = state.baseBranch || baseBranch
      const existingMap = new Map(state.taskGroups.map((g) => [g.id, g]))
      state.taskGroups = parsedGroups.map((p) => {
        const existing = existingMap.get(p.id)

        if (p.id !== args.current_task_group_id) {
          // Non-current group: preserve existing, or add new as not_started
          if (existing) {
            return { ...existing, name: p.name, taskCount: p.taskCount }
          }
          return {
            id: p.id, name: p.name, taskCount: p.taskCount,
            status: "architect_review" as Phase,
            worktreePath: null, branchName: null, baseRef: null,
            executionBoundary: null,
            relevantSpecs: [], lastFilesChanged: [],
            phases: createEmptyPhases(),
          }
        }

        // Current group: rebuild
        const defaultPhase = args.recovery ? args.recovery.phase : "architect_review"
        const phases = args.recovery
          ? buildPhases(args.recovery.phase as BuildPhaseTarget).phases
          : buildPhases("architect_review").phases
        const preserveProgress = args.recovery?.preserve_progress !== false
        if (existing && args.recovery && preserveProgress) {
          // 保留 task 各自状态（不走一刀切覆盖）；新 task 走 taskInjectionStatus
          phases.developer_implement.tasks = newTasks.map((t) => {
            const existingTask = existing.phases.developer_implement.tasks.find((et) => et.id === t.id)
            return existingTask || { ...t, status: taskInjectionStatus }
          })
          // 保留 review 积累
          phases.review.issues = existing.phases.review.issues
          phases.review.progress = existing.phases.review.progress
          phases.review.retryCount = existing.phases.review.retryCount
        } else {
          phases.developer_implement.tasks = newTasks.map((t) => ({
            ...t,
            status: taskInjectionStatus,
          }))
          // Recovery mode without preserve: only preserve review if there are issues (legacy behavior)
          if (existing && args.recovery && existing.phases.review.issues.length > 0) {
            phases.review.issues = existing.phases.review.issues
            phases.review.progress = existing.phases.review.progress
            phases.review.retryCount = existing.phases.review.retryCount
          }
        }

        const base: TaskGroupState = {
          id: p.id, name: p.name, taskCount: p.taskCount,
          status: defaultPhase,
          worktreePath: null, branchName: null, baseRef: null,
          executionBoundary: existing?.executionBoundary ?? null,
          relevantSpecs,
          lastFilesChanged: existing?.lastFilesChanged ?? [],
          phases,
        }

        // Non-recovery: preserve completed architect_review + worktree metadata
        if (existing && !args.recovery) {
          if (existing.phases.architect_review.completed) {
            base.phases.architect_review = { completed: true }
          }
          base.worktreePath = existing.worktreePath
          base.branchName = existing.branchName
          base.baseRef = existing.baseRef
        }

        return base
      })
      state.currentTaskGroupId = args.current_task_group_id
    } else {
      state = {
        changeId: args.change_id,
        currentTaskGroupId: args.current_task_group_id,
        baseBranch,
        taskGroups: parsedGroups.map((p) => {
          const isCurrent = p.id === args.current_task_group_id
          const defaultPhase = args.recovery ? args.recovery.phase : "architect_review"
          const { phases, status } = isCurrent
            ? buildPhases(args.recovery ? (args.recovery.phase as BuildPhaseTarget) : "architect_review")
            : { phases: createEmptyPhases(), status: "architect_review" as Phase }
          if (isCurrent) {
            phases.developer_implement.tasks = newTasks.map((t) => ({
              ...t,
              status: taskInjectionStatus,
            }))
          }
          return {
            id: p.id, name: p.name, taskCount: p.taskCount,
            status,
            worktreePath: null, branchName: null, baseRef: null,
            executionBoundary: null,
            relevantSpecs: isCurrent ? relevantSpecs : [],
            lastFilesChanged: [],
            phases,
          }
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

    // recovery 写入 worktree 信息 + baseRef + diff
    const ctg = findTaskGroup(state, args.current_task_group_id)
    if (args.recovery) {
      ctg.worktreePath = args.recovery.worktree_path
      ctg.branchName = args.recovery.branch_name
      const baseRef = await getMergeBase(args.recovery.worktree_path, baseBranch)
      if (!baseRef) throw new Error(`无法获取 worktree 与 ${baseBranch} 的 merge-base：${args.recovery.worktree_path}`)
      ctg.baseRef = baseRef
      const recoveryIdx = PHASE_ORDER.indexOf(args.recovery.phase)
      const reviewIdx = PHASE_ORDER.indexOf("review")
      if (recoveryIdx >= reviewIdx) {
        ctg.lastFilesChanged = await getDiffFileList(args.recovery.worktree_path, baseRef)
      }
    }

    await writeState(context.worktree, state)

    const recoveryMsg = args.recovery
      ? `已恢复到 ${args.recovery.phase} 阶段。worktree=${args.recovery.branch_name}，baseRef=${ctg.baseRef?.slice(0, 7)}。`
      : ""
    const defaultPhase = args.recovery ? args.recovery.phase : "architect_review"
    let nextStep = ""
    if (defaultPhase === "architect_review" && ctg.phases.architect_review.completed) {
      nextStep = "架构师复核已通过。请调用 opx_orch_set_worktree 设置 worktree 后分派 openspec-developer。"
    } else if (defaultPhase === "architect_review") nextStep = "请分派 openspec-architect 子代理。"
    else if (defaultPhase === "developer_implement" || defaultPhase === "review") nextStep = "请先调用 opx_orch_set_worktree 确保 worktree 就绪，再分派子代理。"
    return JSON.stringify(
      {
        status: "initialized",
        change_id: state.changeId,
        task_group_count: state.taskGroups.length,
        current_task_group: targetGroup,
        active_phase: defaultPhase,
        task_count: newTasks.length,
        message: `编排会话已初始化。仅初始化 TG${args.current_task_group_id}，其余任务组未改动。${recoveryMsg}${nextStep}`,
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_set_worktree
// ═══════════════════════════════════════════════════════════

export const set_worktree = tool({
  description:
    "确保当前任务组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{id}，路径 .worktree/task-group-{id}）。架构师复核通过后调用。进入开发阶段时自动按最终 tasks.md 刷新当前组任务列表；恢复场景仅补齐 worktree、不改阶段。",
  args: {
    worktree_path: tool.schema.string().optional().describe("git worktree 的绝对路径（可选，不传则按规范自动生成）"),
    branch_name: tool.schema.string().optional().describe("worktree 对应的分支名（可选，不传则按规范 task-group/{id}）"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_set_worktree")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.currentTaskGroupId)
    if (!tg.phases.architect_review.completed) {
      throw new Error(`阶段顺序错误：opx_orch_set_worktree 需在 architect_review 完成后调用，当前 architect_review 阶段状态为 "uncompleted"。`)
    }

    const repoRoot = context.worktree
    const branch = args.branch_name || `task-group/${state.currentTaskGroupId}`
    const wtPath = args.worktree_path || path.join(repoRoot, ".worktree", `task-group-${state.currentTaskGroupId}`)

    // 检查 worktree 是否已存在
    const wtList = await runGit(repoRoot, ["worktree", "list"])
    const existingLine = wtList.split("\n").find((l) => {
      const m = l.match(/^(\S+)\s+[0-9a-f]+\s+\[(.+?)\]/)
      return m && m[2].trim() === branch
    })
    const existingPath = existingLine ? existingLine.match(/^(\S+)/)?.[1] : undefined

    let reused = false
    if (existingPath) {
      tg.worktreePath = existingPath
      tg.branchName = branch
      const baseRef = await getMergeBase(existingPath, state.baseBranch)
      if (baseRef) tg.baseRef = baseRef
      reused = true
    } else {
      // 检查路径是否存在但不是 worktree
      try {
        const f = Bun.file(path.join(wtPath, ".git"))
        if (await f.exists()) {
          throw new Error(`路径 "${wtPath}" 已存在 .git 但不在 worktree list 中，请手动检查。`)
        }
      } catch (e: any) {
        if (e.message?.includes("已存在 .git")) throw e
      }

      // 创建新 worktree
      const forkBranch = state.baseBranch
      await runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, forkBranch])

      const baseRef = await getMergeBase(wtPath, forkBranch)
      if (!baseRef) throw new Error(`worktree 创建成功但无法获取与 ${forkBranch} 的 merge-base：${wtPath}`)

      tg.worktreePath = wtPath
      tg.branchName = branch
      tg.baseRef = baseRef
    }

    // 有条件 Phase 2 进入块：仅从 architect_review 进入开发时触发
    if (tg.status === "architect_review") {
      const isTasksEmpty = tg.phases.developer_implement.tasks.length === 0
      const allOpen = tg.phases.developer_implement.tasks.every((t) => t.status === "open")
      if (!isTasksEmpty && !allOpen) {
        throw new Error(
          `进入开发阶段时当前组 task 列表异常（非空且非全部 open），无法安全刷新。` +
          `请检查 state 文件 ${state.changeId} 是否与 tasks.md 一致。`
        )
      }
      if (isTasksEmpty || allOpen) {
        const parsedTasks = await parseTasksMdForGroup(context.worktree, state.changeId, state.currentTaskGroupId)
        const newRelevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
        tg.phases.developer_implement.tasks = parsedTasks.map((p, i) => ({
          id: String(i + 1),
          tasksMdRef: p.tasksMdRef,
          specTrace: p.specTrace,
          title: p.title,
          status: "open" as TaskStatus,
          taskNumber: p.taskNumber,
        }))
        tg.relevantSpecs = newRelevantSpecs
      }
      tg.phases.developer_implement.completed = false
      tg.status = "developer_implement"
    }

    await writeState(context.worktree, state)

    const msg = reused
      ? `复用已有 worktree：${existingPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
      : `已创建 worktree：${wtPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
    const next = tg.status === "developer_implement"
      ? "请分派 openspec-developer 子代理。"
      : `当前阶段为 ${tg.status}，请按对应流程推进。`
    return JSON.stringify(
      {
        status: "ok",
        reused,
        worktree_path: tg.worktreePath,
        branch_name: branch,
        base_ref: tg.baseRef,
        message: msg + next,
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_status
// ═══════════════════════════════════════════════════════════

export const status = tool({
  description:
    "统一只读状态/上下文查询。按调用者（context.agent）角色路由返回：orchestrator 看统计信息 + 磁盘 worktree 发现；architect 看 spec 与 task/issue 明细；developer 看 worktree/boundary/task 与 issue 清单；reviewer 自维度存量 issue 与上轮变更。无任何写入语义。",
  args: {},
  async execute(_args, context) {
    const state = await readStateByWorktree(context.worktree)
    const agent = context.agent

    if (!state) {
      if (agent === ORCHESTRATOR_AGENT) {
        const diskWts = await discoverDiskWorktrees(context.worktree)
        if (diskWts.length > 0) {
          const lines = ["# 编排进度", "", "**状态文件**: 未初始化", "", "## 磁盘 Worktree（可恢复进度）", ""]
          lines.push("| 分支 | 路径 |")
          lines.push("|------|------|")
          for (const w of diskWts) lines.push(`| ${w.branch} | \`${w.path}\` |`)
          lines.push("")
          lines.push("请用 question 工具询问用户确认恢复目标，然后调用 opx_orch_init(recovery=...)。")
          return lines.join("\n")
        }
      }
      return JSON.stringify({ initialized: false, message: "编排会话尚未初始化。" }, null, 2)
    }

    const tg = findTaskGroup(state, state.currentTaskGroupId)
    let view: string
    if (agent === ORCHESTRATOR_AGENT) {
      const diskWts = await discoverDiskWorktrees(context.worktree)
      view = renderOrchestratorView(state, tg, diskWts)
    } else if (agent === "openspec-architect") {
      view = renderArchitectView(state, tg)
    } else if (agent === "openspec-developer") {
      view = renderDeveloperView(state, tg)
    } else if (Object.values(DIMENSION_AGENT_MAP).includes(agent)) {
      view = renderReviewerView(state, tg, agent)
    } else {
      view = renderOrchestratorView(state, tg)
    }
    return view
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_complete_task_group
// ═══════════════════════════════════════════════════════════

export const complete_task_group = tool({
  description:
    "完成任务组收尾：合并 task-group 分支到 merge_target → 清理 worktree 与分支 → 推进阶段。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
  args: {
    merge_target: tool.schema.string().min(1).describe("合并目标本地分支名（如 main、develop）"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_complete_task_group")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.currentTaskGroupId)
    if (!tg.phases.review.completed || tg.status === "completed") {
      throw new Error(
        `阶段顺序错误：opx_orch_complete_task_group 需在 review 完成后调用，当前 review.completed=${tg.phases.review.completed}，tg.status=${tg.status}。`
      )
    }
    if (tg.worktreePath) {
      const clean = await isWorktreeClean(tg.worktreePath)
      if (!clean) throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再完成任务组。`)
    }
    // 校验无阻塞 issue 与未完成 task
    const openIssues = tg.phases.review.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
    )
    if (openIssues.length > 0) {
      throw new Error(`存在 ${openIssues.length} 个 Low 及以上的 open/rejected issue 未处理，请先修复或申请豁免。`)
    }
    const openTasks = tg.phases.developer_implement.tasks.filter(
      (t) => t.status === "open" || t.status === "submitted" || t.status === "rejected"
    )
    if (openTasks.length > 0) {
      throw new Error(`存在 ${openTasks.length} 个未完成 task。`)
    }
    // 合并分支到目标
    if (tg.branchName) {
      const mergeResult = await mergeBranchToTarget(context.worktree, tg.branchName, args.merge_target)
      if (!mergeResult.success) {
        return JSON.stringify(
          {
            status: "blocked",
            merge_conflict: true,
            message:
              `合并到 "${args.merge_target}" 时发生冲突，已中止合并。` +
              `请手动在目标分支解决冲突后完成合并 (git merge ${tg.branchName})，` +
              `完成后重新调 opx_orch_complete_task_group 完成收尾。worktree 与分支已保留。`,
          },
          null,
          2
        )
      }
    }
    // 清理 worktree 与分支
    if (tg.worktreePath && tg.branchName) {
      try {
        await runGit(context.worktree, ["worktree", "remove", tg.worktreePath, "--force"])
        await runGit(context.worktree, ["branch", "-D", tg.branchName])
      } catch {
        // 清理失败不阻塞完成，仅记录
      }
    }
    tg.status = "completed"
    // 推进 currentTaskGroupId 到下个 pending
    const next = state.taskGroups.find((g) => g.status === "architect_review" && g.id !== state.currentTaskGroupId && phasesAllEmpty(g))
    if (next) state.currentTaskGroupId = next.id
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        completed_task_group: tg.id,
        merge_target: args.merge_target,
        next_task_group: next?.id ?? null,
        message: next
          ? `任务组 "${tg.name}" 已完成并合并到 "${args.merge_target}"。下一任务组: "${next.name}"。请调用 opx_orch_init 开始。`
          : `任务组 "${tg.name}" 已完成并合并到 "${args.merge_target}"。所有任务组均已完成。`,
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_arch_submit
// ═══════════════════════════════════════════════════════════

export const arch_submit = tool({
  description:
    "架构师 Phase 1 提交复核报告。passed=false 时 architect_review 保持 in_progress（编排者需向用户展示问题清单并询问处理方式，用户答复后重新分派 architect 补全文档并提交 passed=true，随后调用 opx_orch_init 同步 state）；passed=true 时 execution_boundary 必须提供。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    passed: tool.schema.boolean().describe("复核是否通过"),
    issues: tool.schema.array(architectIssue).describe("问题清单（通过时为空数组）"),
    execution_boundary: executionBoundarySchema.optional().describe("developer 执行边界（passed=true 时必须提供）"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_arch_submit", ["openspec-architect"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.currentTaskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：当前活跃任务组为 "${state.currentTaskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "architect_review") {
      throw new Error(`阶段顺序错误：architect_review 当前不在活跃阶段，当前阶段为 "${tg.status}"。`)
    }
    assertPassWithIssues(args.passed, args.issues, "opx_arch_submit")
    if (args.passed) {
      if (!args.execution_boundary) {
        throw new Error("passed=true 时必须提供 execution_boundary。")
      }
      tg.executionBoundary = args.execution_boundary
      tg.phases.architect_review.completed = true
      // 提交架构师编辑的 openspec 文档，确保后续 worktree fork 包含更新
      const changeDir = `openspec/changes/${state.changeId}`
      const statusResult = await runGitChecked(context.worktree, ["status", "--porcelain", changeDir])
      if (!statusResult.success) {
        throw new Error(`git status openspec 文档失败：${statusResult.stderr}`)
      }
      if (statusResult.stdout) {
        const addResult = await runGitChecked(context.worktree, ["add", changeDir])
        if (!addResult.success) {
          throw new Error(`git add openspec docs 失败：${addResult.stderr}`)
        }
        const commitResult = await runGitChecked(context.worktree, [
          "commit", "-m", `docs(openspec): refine specs for task-group ${args.task_group_id}`,
        ])
        if (!commitResult.success) {
          throw new Error(`git commit openspec docs 失败：${commitResult.stderr}`)
        }
      }
      // 不自动推进 status，等编排者调 opx_orch_set_worktree
      await writeState(context.worktree, state)
      return JSON.stringify(
        {
          status: "ok",
          phase: "architect_review=completed",
          execution_boundary: args.execution_boundary,
          message: "[面向 architect] 复核通过，职责已完成，请立即结束当前会话。\n[面向编排者] 架构师复核通过。请调用 opx_orch_set_worktree 设置 worktree 后分派 openspec-developer。",
        },
        null,
        2
      )
    }
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "blocked",
        phase: "architect_review",
        issue_count: args.issues.length,
        issues: args.issues,
        message: "[面向 architect] 复核不通过，职责已完成，请立即结束当前会话。\n[面向编排者] ⚠️ 架构师复核不通过，请向用户展示信息缺口问题清单，用 question 询问处理方式。用户答复后再次分派 architect 补全文档，architect 提交 passed=true 后调用 opx_orch_init 同步 state，然后调 set_worktree 进入 dev 阶段。",
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_arch_exempt_review
// ═══════════════════════════════════════════════════════════

const exemptReviewItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("申请豁免的 issue ID"),
  decision: tool.schema.enum(["grant", "reject"]).describe("grant=批准豁免；reject=驳回"),
  reason: tool.schema.string().min(1).describe("裁定理由"),
})

export const arch_exempt_review = tool({
  description:
    "架构师 Phase 3（review 阶段收尾）对 developer 申请豁免的 issue 进行裁定。grant 置 exempted，reject 置 rejected（developer 必须修复，不可二次申请豁免）。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    reviews: tool.schema.array(exemptReviewItem).min(1).describe("裁定清单"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_arch_exempt_review", ["openspec-architect"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.currentTaskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：当前活跃任务组为 "${state.currentTaskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`阶段顺序错误：当前阶段为 "${tg.status}"，豁免复核需在 review 阶段进行中调用。`)
    }
    const granted: string[] = []
    const rejected: string[] = []
    for (const r of args.reviews) {
      const issue = tg.phases.review.issues.find((i) => i.id === r.issue_id)
      if (!issue) throw new Error(`issue #${r.issue_id} 不在任务组 ${args.task_group_id} 的 issue 清单中。`)
      if (issue.status !== "exemption") {
        throw new Error(`issue #${r.issue_id} 当前 status="${issue.status}"，仅 exemption 状态的 issue 可被裁定。`)
      }
      if (r.decision === "grant") {
        issue.status = "exempted"
        granted.push(r.issue_id)
      } else {
        issue.status = "rejected"
        rejected.push(r.issue_id)
      }
    }
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        granted,
        rejected,
        message: `裁定完成：批准 ${granted.length} 项、驳回 ${rejected.length} 项。`,
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_dev_submit
// ═══════════════════════════════════════════════════════════

const requestExemptItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("申请豁免的 issue ID"),
  reason: tool.schema.string().min(1).describe("豁免理由"),
})

export const dev_submit = tool({
  description:
    "developer 提交实现结果。根据 status 区分 task 提交还是 issue 修复：\n" +
    "- developer_implement 阶段：标记 task 为 submitted，切换 status=validating\n" +
    "- review 阶段：标记 issue 为 submitted（已修复）或 exemption（申请豁免）",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("确认修复的 issue ID 列表"),
    request_exempts: tool.schema.array(requestExemptItem).optional().describe("不可修的 issue 申请豁免"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_dev_submit", ["openspec-developer"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.currentTaskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：当前活跃任务组为 "${state.currentTaskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "developer_implement" && tg.status !== "review") {
      throw new Error(`dev_submit 仅在 developer_implement 或 review 阶段可用，当前阶段为 "${tg.status}"。`)
    }
    if (!tg.worktreePath || !tg.baseRef) {
      throw new Error("worktree 或 baseRef 未设置，请编排者先调用 opx_orch_set_worktree。")
    }
    const clean = await isWorktreeClean(tg.worktreePath)
    if (!clean) {
      throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再 submit。`)
    }
    tg.lastFilesChanged = await getDiffFileList(tg.worktreePath, tg.baseRef)

    let nextMsg = ""

    let requiredDims: ReviewDimension[] = []

    if (tg.status === "developer_implement") {
      // Task 提交模式：open/rejected task 均标记为 submitted（rejected 为 validator 驳回后 dev 重做）
      for (const task of tg.phases.developer_implement.tasks) {
        if (task.status === "open" || task.status === "rejected") task.status = "submitted"
      }
      // 完成度门禁：不允许残留 open/rejected task
      const remainingTasks = tg.phases.developer_implement.tasks.filter(
        (t) => t.status === "open" || t.status === "rejected"
      )
      if (remainingTasks.length > 0) {
        throw new Error(
          `存在 ${remainingTasks.length} 个 open/rejected task 未完成，无法提交：` +
            remainingTasks.map((t) => `#${t.id} ${t.title}`).join("; ")
        )
      }
      // Phase 2 issue 修复：标记为 submitted
      const fixedIds = args.fixed_issue_ids || []
      for (const id of fixedIds) {
        const issue = tg.phases.developer_implement.issues.find((i) => i.id === id)
        if (issue && (issue.status === "open" || issue.status === "rejected")) {
          issue.status = "submitted"
        }
      }
      // Phase 2 issue 完成度门禁：Low+ 的 open/rejected 必须全部修复
      const remainingPhase2 = tg.phases.developer_implement.issues.filter(
        (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
      )
      if (remainingPhase2.length > 0) {
        throw new Error(
          `存在 ${remainingPhase2.length} 个 Low 及以上 Phase 2 issue 未修复` +
            remainingPhase2.map((i) => `#${i.id}(${i.severity})`).join("; ")
        )
      }
      nextMsg = "请分派 validator 验证 task 产出和工具合规性"
    } else {
      // Issue 修复模式：处理 fixed_issue_ids + request_exempts
      const fixedIds = args.fixed_issue_ids || []
      for (const id of fixedIds) {
        const issue = tg.phases.review.issues.find((i) => i.id === id)
        if (issue && (issue.status === "open" || issue.status === "rejected")) {
          issue.status = "submitted"
        }
      }
      const requestedIds: string[] = []
      for (const r of args.request_exempts || []) {
        const issue = tg.phases.review.issues.find((i) => i.id === r.issue_id)
        if (!issue) throw new Error(`issue #${r.issue_id} 不在任务组 ${args.task_group_id} 的 issue 清单中。`)
        if (issue.status === "exempted") {
          throw new Error(`issue #${r.issue_id} 已被豁免，无需重复申请。`)
        }
        if (issue.status === "rejected") {
          throw new Error(`issue #${r.issue_id} 的豁免申请已被架构师驳回，必须修复，不可二次申请豁免。`)
        }
        if (issue.status === "verified") {
          throw new Error(`issue #${r.issue_id} 已通过验证，无需申请豁免。`)
        }
        issue.status = "exemption"
        issue.exemptReason = r.reason
        requestedIds.push(r.issue_id)
      }
      // 完成度门禁：Low 及以上的 open/rejected issue 必须全部修复或申请豁免（Info 可残留）
      const remainingBlocking = tg.phases.review.issues.filter(
        (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
      )
      if (remainingBlocking.length > 0) {
        throw new Error(
          `存在 ${remainingBlocking.length} 个 Low 及以上的 open/rejected issue 未处理，无法提交（请逐条修复或申请豁免）：` +
            remainingBlocking.map((i) => `#${i.id}(${i.severity}/${i.dimension})`).join("; ")
        )
      }
      requiredDims = computeRequiredDims(tg)
      nextMsg = requestedIds.length > 0
        ? `请分派 architect 裁定豁免申请，同时分派 reviewer 确认已修复 issue`
        : "请分派各 reviewer 重新审查"
    }

    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        active_phase: tg.status,
        required_dimensions: requiredDims,
        message: `提交完成。\n下一步：${nextMsg}` +
          (tg.status === "review"
            ? `\n本轮需审查维度（激活集）：${requiredDims.length > 0 ? requiredDims.join(", ") : "(无——所有修复已由既有维度覆盖或仅剩豁免/Info)"}`
            : ""),
      },
      null,
      2
    )
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_reviewer_submit
// ═══════════════════════════════════════════════════════════

const taskVerifyItem = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID（task 清单中 task 项的 id）"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

export const reviewer_submit = tool({
  description:
    "审核人统一提交。dimension=task 由 validator 使用，验证 task 产出；dimension=style/architecture/performance/security/maintainability/test 由对应的 reviewer 使用，提交审查结果。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    dimension: tool.schema.enum(ALL_DIMENSIONS).describe("审核维度（task/style/architecture/performance/security/maintainability/test）"),
    verified_task_ids: tool.schema.array(tool.schema.string()).optional().describe("dimension=task 时：已验证完成的 task ID 列表"),
    failed_task_ids: tool.schema.array(taskVerifyItem).optional().describe("dimension=task 时：未完成的 task 列表"),
    passed: tool.schema.boolean().optional().describe("非 task 维度：本维度是否通过"),
    issues: tool.schema.array(reviewIssue).optional().describe("问题清单（代码维度：新报审查 issue；task 维度：validator 上报工具违规）"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    test_results: tool.schema.string().optional().describe("dimension=test 时必填：mvn test 摘要"),
  },
  async execute(args, context) {
    const expectedAgent = DIMENSION_AGENT_MAP[args.dimension]
    assertAgent(context, "opx_reviewer_submit", [expectedAgent])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.currentTaskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：当前活跃任务组为 "${state.currentTaskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)

    // ── Task 维度：Validator 验证 task ──
    if (args.dimension === TASK_DIM) {
      if (tg.status !== "developer_implement") {
        throw new Error(`task 维度提交需在 developer_implement 阶段调用，当前阶段为 "${tg.status}"。`)
      }
      if (deriveDevStatus(tg.phases.developer_implement) !== "validating") {
        throw new Error(`task 审核仅在 developer 提交后（validating 阶段）允许，当前为 developing 阶段。`)
      }
      const verified = args.verified_task_ids || []
      const failed = args.failed_task_ids || []
      const tasks = tg.phases.developer_implement.tasks

      // Fix 1: 非法 id fail-fast
      const validIds = new Set(tasks.map((t) => t.id))
      const unknownVerified = verified.filter((id) => !validIds.has(id))
      const unknownFailed = failed.filter((f) => !validIds.has(f.task_id))
      if (unknownVerified.length > 0 || unknownFailed.length > 0) {
        throw new Error(
          `非法 task id：${[...unknownVerified.map((id) => `"${id}"`), ...unknownFailed.map((f) => `"${f.task_id}"`)].join(", ")}。` +
          `合法 id：${Array.from(validIds).join(", ")}。` +
          `注意：id 是 Task id 列的数字（如 "1"），不是 tasks.md 编号（如 "3.1"）。`
        )
      }

      // Fix 4: 完整性门禁——每个 submitted task 必须被覆盖
      const submittedTasks = tasks.filter((t) => t.status === "submitted")
      const coveredIds = new Set([...verified, ...failed.map((f) => f.task_id)])
      const uncovered = submittedTasks.filter((t) => !coveredIds.has(t.id))
      if (uncovered.length > 0) {
        throw new Error(
          `以下 submitted task 未被 verified_task_ids 或 failed_task_ids 覆盖：` +
          uncovered.map((t) => `#${t.id} ${t.title}`).join("; ") +
          `。提交时必须对所有 submitted task 明确结论。`
        )
      }

      let actualVerified = 0
      for (const id of verified) {
        const task = tasks.find((t) => t.id === id)
        if (task && task.status === "submitted") { task.status = "verified"; actualVerified++ }
      }
      let actualFailed = 0
      for (const f of failed) {
        const task = tasks.find((t) => t.id === f.task_id)
        if (task && task.status === "submitted") { task.status = "rejected"; actualFailed++ }
      }
      // 处理 validator 上报的 issue
      const rawIssues = (args.issues || []) as any[]
      let nextIssueId = tg.phases.developer_implement.issues.reduce((m, i) => {
        return Math.max(m, parseInt(i.id, 10) || 0)
      }, 0) + 1
      let dedupedCount = 0
      for (const iss of rawIssues) {
        const isDuplicate = tg.phases.developer_implement.issues.some(
          (existing) =>
            existing.dimension === TASK_DIM &&
            existing.file === iss.file &&
            existing.line === iss.line &&
            existing.description === iss.description &&
            (existing.status === "open" || existing.status === "submitted" || existing.status === "rejected")
        )
        if (isDuplicate) { dedupedCount++; continue }
        tg.phases.developer_implement.issues.push({
          id: String(nextIssueId++),
          dimension: TASK_DIM,
          severity: iss.severity,
          file: iss.file,
          line: iss.line,
          description: iss.description,
          suggestion: iss.suggestion || "",
          status: "open",
          firstRound: 1,
          type: iss.type || null,
          rootCauseGuess: null,
          exemptReason: null,
        })
      }
      // 将新 issue 指向的目录并入执行边界
      if (tg.executionBoundary && rawIssues.length > 0) {
        const dirs = tg.executionBoundary.allowed_directories
        for (const iss of rawIssues) {
          const dir = path.dirname(iss.file)
          const entry = dir === "" || dir === "." ? iss.file : dir
          if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
        }
      }
      // 确认 Phase 2 issue 修复 + 省略即驳回
      const fixedPhase2Ids = args.fixed_issue_ids || []
      for (const id of fixedPhase2Ids) {
        const issue = tg.phases.developer_implement.issues.find((i) => i.id === id)
        if (issue && issue.status === "submitted") issue.status = "verified"
      }
      for (const issue of tg.phases.developer_implement.issues) {
        if (issue.status === "submitted" && !fixedPhase2Ids.includes(issue.id)) {
          issue.status = "rejected"
        }
      }
      // 回写 tasks.md checkbox
      if (verified.length > 0 && tg.worktreePath) {
        await updateTasksMdForVerifiedTasks(tg.worktreePath, state.changeId, tasks, verified)
      }
      const allTasksDone = tasks.every(
        (t) => t.status === "verified" || t.status === "skipped"
      )
      const allPhase2IssuesDone = tg.phases.developer_implement.issues.every(
        (i) => i.status === "verified" || i.status === "exempted" || i.status === "skipped"
      )
      const allDone = allTasksDone && allPhase2IssuesDone
      if (allDone) {
        tg.phases.developer_implement.completed = true
        tg.status = "review"
      }
      await writeState(context.worktree, state)
      const dedupMsg = dedupedCount > 0 ? `；${dedupedCount} 个重复 issue 已自动跳过` : ""
      const phase2Msg = rawIssues.length > 0 ? `，Phase 2 issue ${rawIssues.length - dedupedCount} 个` : ""
      return JSON.stringify({
        status: allDone ? "ok" : "partial",
        phase: allDone ? "developer_implement=completed, review=in_progress" : "developer_implement(retry)",
        message: allDone
          ? "所有 task 和 Phase 2 issue 已完成，进入 review 阶段。请并行分派 6 个代码维度 reviewer。"
          : `实际生效：已验证 ${actualVerified} 个 task，${actualFailed} 个未通过${phase2Msg}${dedupMsg}。等待 developer 补充实现。`,
      })
    }

    // ── 代码维度：Reviewer 提交审查 ──
    if (tg.status !== "review") {
      throw new Error(`代码维度提交需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
    }

    if (tg.phases.review.progress[args.dimension as ReviewDimension].submitted) {
      throw new Error(`维度 "${args.dimension}" 的审查报告已提交，不允许重复提交。`)
    }

    const passed = args.passed === true
    const issues = (args.issues || []) as any[]
    assertPassWithIssues(passed, issues, "opx_reviewer_submit")

    const fixedIds = args.fixed_issue_ids || []
    for (const id of fixedIds) {
      const issue = tg.phases.review.issues.find((i) => i.id === id)
      if (issue && issue.status === "submitted") {
        issue.status = "verified"
      }
    }
    // §6 省略即驳回：本维度内未被 fixed_issue_ids 确认的 submitted issue → rejected（视为驳回该修复）
    for (const issue of tg.phases.review.issues) {
      if (issue.dimension === args.dimension && issue.status === "submitted" && !fixedIds.includes(issue.id)) {
        issue.status = "rejected"
      }
    }

    let nextIssueId = tg.phases.review.issues.reduce((m, i) => {
      return Math.max(m, parseInt(i.id, 10) || 0)
    }, 0) + 1
    let dedupedCount = 0
    const newIssues: IssueItem[] = []
    for (const iss of issues) {
      if (args.dimension === TEST_DIM) {
        if (!iss.type || !(TEST_ISSUE_TYPES as readonly string[]).includes(iss.type)) {
          throw new Error(`dimension="test" 的 issue 缺少有效 type 字段（可选：${TEST_ISSUE_TYPES.join(", ")}）。`)
        }
        if (!iss.root_cause_guess || typeof iss.root_cause_guess !== "string" || iss.root_cause_guess.trim() === "") {
          throw new Error(`dimension="test" 的 issue 必须提供非空 root_cause_guess。`)
        }
      } else {
        if (!iss.suggestion || typeof iss.suggestion !== "string" || iss.suggestion.trim() === "") {
          throw new Error(`dimension="${args.dimension}" 的 issue 必须提供非空 suggestion。`)
        }
      }
      // §6 确定性去重：dimension+file+line+description 全等匹配时跳过（仅与 open/submitted/rejected 状态比对）
      const isDuplicate = tg.phases.review.issues.some(
        (existing) =>
          existing.dimension === args.dimension &&
          existing.file === iss.file &&
          existing.line === iss.line &&
          existing.description === iss.description &&
          (existing.status === "open" || existing.status === "submitted" || existing.status === "rejected")
      )
      if (isDuplicate) {
        dedupedCount++
        continue
      }
      newIssues.push({
        id: String(nextIssueId++),
        dimension: args.dimension as Dimension,
        severity: iss.severity,
        file: iss.file,
        line: iss.line,
        description: iss.description,
        suggestion: iss.suggestion || iss.root_cause_guess || "",
        status: "open",
        firstRound: tg.phases.review.retryCount + 1,
        type: args.dimension === TEST_DIM ? iss.type : null,
        rootCauseGuess: args.dimension === TEST_DIM ? iss.root_cause_guess : null,
        exemptReason: null,
      })
    }
    tg.phases.review.issues.push(...newIssues)
    // §5 将新报 issue 指向的文件目录并入执行边界，确保 fixer 可修复被标记文件而不触发超边界暂停
    if (tg.executionBoundary && newIssues.length > 0) {
      const dirs = tg.executionBoundary.allowed_directories
      for (const iss of newIssues) {
        const dir = path.dirname(iss.file)
        const entry = dir === "" || dir === "." ? iss.file : dir
        if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
      }
    }
    tg.phases.review.progress[args.dimension as ReviewDimension] = { submitted: true, passed }
    await writeState(context.worktree, state)
    const testResults = args.dimension === TEST_DIM ? (args.test_results || "") : ""
    const resultStr = await finalizeOrPartial(state, tg, args.dimension as ReviewDimension, passed, context, testResults)
    if (dedupedCount > 0) {
      const result = JSON.parse(resultStr)
      result.deduped = dedupedCount
      result.message =
        result.message.replace(/([。！])\s*$/, `；${dedupedCount} 个重复 issue 已自动跳过。`)
      return JSON.stringify(result)
    }
    return resultStr
  },
})

// ─── 工具函数：判定本轮是否全部 submitted + 整体判定 ───

async function finalizeOrPartial(
  state: OrchestrateState,
  tg: TaskGroupState,
  dimension: ReviewDimension,
  passed: boolean,
  context: { worktree: string },
  testResults: string = ""
): Promise<string> {
  // §3 动态激活维度（不持久化）——门禁口径与 computeRequiredDims（分派口径）一致：
  //   首轮（retryCount===0）：全部 6 维（建立审查基线）；
  //   修复轮（retryCount≥1）：本轮已提交审查（progress.submitted）∪ 存在 submitted issue 待确认的维度。
  // 未解决的 Low+ open/rejected 不进门禁——否则"某维度未被分派却被要求提交"会 partial 死锁
  //（如 architect 驳回未分派维度的 exemption→rejected）；改由下方 hasResidualBlocking 强制 rejected 另起一轮。
  const allDims = Object.keys(tg.phases.review.progress) as ReviewDimension[]
  const submittedDims = dimsWithSubmittedIssue(tg)
  const requiredDims: ReviewDimension[] =
    tg.phases.review.retryCount === 0
      ? allDims
      : allDims.filter((d) => tg.phases.review.progress[d].submitted || submittedDims.has(d))
  const allSubmitted = requiredDims.every((d) => tg.phases.review.progress[d].submitted)

  if (!allSubmitted) {
    const submittedCount = requiredDims.filter((d) => tg.phases.review.progress[d].submitted).length
    const totalCount = requiredDims.length
    return JSON.stringify({
      status: "partial",
      dimension,
      dimension_passed: passed,
      submitted: `${submittedCount}/${totalCount}`,
      active_dimensions: requiredDims,
      message: `[${dimension}] 已提交（激活维度 ${submittedCount}/${totalCount}）。等待其余激活维度审查报告，全部提交后自动判定整体结果。`,
    })
  }

  const failedDims: ReviewDimension[] = []
  for (const d of requiredDims) {
    if (!tg.phases.review.progress[d].passed) failedDims.push(d)
  }
  // 残留的 Low+ open/rejected（含 architect 驳回豁免后回退的 rejected）——强制再修一轮，不放行 ok
  const hasResidualBlocking = tg.phases.review.issues.some(
    (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
  )

  if (failedDims.length === 0 && !hasResidualBlocking) {
    tg.phases.review.completed = true
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "ok",
      phase: "review=completed",
      message: `全部审查维度通过。请调用 opx_orch_complete_task_group 收尾（合并+清理）。`,
    })
  }

  tg.phases.review.retryCount++
  const retryCount = tg.phases.review.retryCount
  const reason =
    failedDims.length > 0
      ? `${failedDims.join(", ")} 未通过`
      : "存在未解决的 Low+ open/rejected issue"

  if (retryCount > MAX_RETRIES) {
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "needs_user_decision",
      retry_count: retryCount,
      failed_dimensions: failedDims,
      has_residual_blocking: hasResidualBlocking,
      message:
        `审查已进行 ${retryCount} 轮（超过上限 ${MAX_RETRIES}），需要用户决策。` +
        `原因：${reason}。` +
        `请用 question 工具向用户展示剩余 issue 摘要，选项：[继续修复, 放弃]，` +
        `再据答案调用 opx_orch_resolve_review(decision="continue"|"giveup")。`,
    })
  }

  tg.phases.review.progress = createEmptyReviewProgress()
  await writeState(context.worktree, state)
  return JSON.stringify({
    status: "rejected",
    phase: "review(in_progress)",
    retry_count: retryCount,
    max_retries: MAX_RETRIES,
    failed_dimensions: failedDims,
    has_residual_blocking: hasResidualBlocking,
    message:
      `审查不通过（第 ${retryCount}/${MAX_RETRIES} 轮）：${reason}。` +
      `[面向编排者] 1. 若 issues 中存在 status=exemption 的 issue，先分派 openspec-architect 裁定；` +
      `2. 再分派 openspec-developer 修复 open/rejected issue 后调用 opx_dev_submit。`,
  })
}

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_resolve_review
// ═══════════════════════════════════════════════════════════

export const resolve_review = tool({
  description:
    "编排者在 review 阶段重试超上限（needs_user_decision）后，据用户决策推进：\n" +
    "- decision=continue：重置重试计数与审查进度，回到全维度基线审查（恢复重试预算）\n" +
    "- decision=giveup：将剩余 Low+ open/rejected 及待裁定 exemption 置 exempted，标记 review 完成（open 的 Info 保留，不阻塞收尾）",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    decision: tool.schema
      .enum(["continue", "giveup"])
      .describe("continue=继续修复（重置重试计数与进度）；giveup=放弃（豁免剩余 Low+ 后进入合并清理）"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_resolve_review")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.currentTaskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：当前活跃任务组为 "${state.currentTaskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`opx_orch_resolve_review 仅在 review 阶段可用，当前阶段为 "${tg.status}"。`)
    }
    if (tg.phases.review.retryCount <= MAX_RETRIES) {
      throw new Error(
        `opx_orch_resolve_review 仅在审查重试超上限（retryCount > ${MAX_RETRIES}，needs_user_decision 状态）时调用；` +
          `当前 retryCount=${tg.phases.review.retryCount}，请按常规 rejected 流程分派 developer 修复。`
      )
    }

    if (args.decision === "continue") {
      tg.phases.review.retryCount = 0
      tg.phases.review.completed = false
      tg.phases.review.progress = createEmptyReviewProgress()
      await writeState(context.worktree, state)
      return JSON.stringify(
        {
          status: "ok",
          decision: "continue",
          phase: "review(in_progress)",
          message:
            "已重置重试计数与审查进度，回到全维度基线审查。" +
            "请分派 openspec-developer(fixer) 修复剩余 issue 后调用 opx_dev_submit，再并行分派 6 个 reviewer 重新审查。",
        },
        null,
        2
      )
    }

    // decision === "giveup"：豁免剩余待处理项（待裁定 exemption、Low+ 的 open/rejected/submitted），标记 review 完成
    let exemptedCount = 0
    for (const issue of tg.phases.review.issues) {
      if (issue.status === "exemption") {
        issue.status = "exempted"
        exemptedCount++
      } else if (
        (issue.status === "open" || issue.status === "rejected" || issue.status === "submitted") &&
        isBlockingIssue(issue)
      ) {
        issue.status = "exempted"
        exemptedCount++
      }
    }
    tg.phases.review.completed = true
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        decision: "giveup",
        exempted_count: exemptedCount,
        phase: "review=completed",
        message:
          `已将剩余 ${exemptedCount} 个 Low+ open/rejected 及待裁定 issue 置为 exempted。` +
          "请调用 opx_orch_complete_task_group 收尾（合并+清理；open 的 Info issue 保留、不阻塞完成）。",
      },
      null,
      2
    )
  },
})
