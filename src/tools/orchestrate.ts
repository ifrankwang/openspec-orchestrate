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

const CODE_DIMENSIONS = ["style", "architecture", "performance", "security", "maintainability"] as const
const REVIEW_DIMENSIONS = [...CODE_DIMENSIONS] as const
type ReviewDimension = typeof REVIEW_DIMENSIONS[number]
type Dimension = ReviewDimension

// ─── Zod Schema ───

const architectIssue = tool.schema.object({
  file: tool.schema.string().min(1).describe("问题所在文件路径（相对于 worktree）"),
  line: tool.schema.number().int().positive().describe("问题所在行号"),
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别（Critical/High/Medium/Low/Info）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema.string().optional().describe("修改建议"),
})

const executionBoundarySchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能修改/创建文件的目录列表（含实施与验证所需的测试代码目录）"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).min(1).describe("developer 只能新增/修改代码的包路径列表（含对应的测试包路径）"),
  notes: tool.schema.string().describe("实施建议：关键坑位提醒、组件复用指引、设计约束边缘场景、框架应用说明（如 MapStruct 对象转换）；不含目录/包路径（见 allowed_directories/allowed_packages），无则留空"),
})

const boundaryExpansionSchema = tool.schema.object({
  allowed_directories: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许目录"),
  allowed_packages: tool.schema.array(tool.schema.string().min(1)).optional().describe("reviewer 声明的额外允许包路径"),
})

const reviewIssue = tool.schema.object({
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别（Critical/High/Medium/Low/Info）"),
  file: tool.schema.string().min(1).describe("问题所在文件路径（相对于 worktree）"),
  line: tool.schema.number().int().min(0).describe("问题所在行号（0=整文件/待新建文件，如 tool 改进 issue 指向待建配置文件）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema
    .string()
    .optional()
    .describe("修复建议"),
  root_cause_guess: tool.schema
    .string()
    .optional()
    .describe("根因猜测（仅特定维度需要）"),
})

// ─── 状态类型 ───

type Phase = "task_analysis" | "dev_impl" | "review" | "completed"
/** buildPhases 的有效目标阶段（不含 "completed"） */
type BuildPhaseTarget = "task_analysis" | "dev_impl" | "review"
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
  rejectReason: string | null
}

interface IssueItem {
  id: string
  dimension: Dimension
  sourcePhase: "tool" | "task" | "quality"
  severity: string
  file: string
  line: number
  description: string
  suggestion: string
  status: IssueStatus
  refixCount: number
  rootCauseGuess: string | null
  exemptReason: string | null
  rejectReason: string | null
}

interface DimensionProgress {
  submitted: boolean
  passed: boolean
}

type QualityLayerProgress = Record<ReviewDimension, DimensionProgress>

interface ReviewLayerData {
  completed: boolean
  testResults?: string
}

interface DevPhaseData {
  completed: boolean
}

interface ReviewPhaseData {
  completed: boolean
  retryCount: number
  lastResolvedRetryCount: number
  tool: ReviewLayerData
  task: ReviewLayerData
  quality: ReviewLayerData & { progress: QualityLayerProgress; baselineDone: boolean }
}

interface SimplePhaseData {
  completed: boolean
}

interface Phases {
  architect_review: SimplePhaseData
  dev_impl: DevPhaseData
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
  tasks: TaskItem[]
  issues: IssueItem[]
}

interface OrchestrateState {
  changeId: string
  taskGroupId: string
  baseBranch: string
  taskGroups: TaskGroupState[]
  createdAt: string
  updatedAt: string
}

// ─── 辅助函数 ───

function createEmptyPhases(): Phases {
  return {
    architect_review: { completed: false },
    dev_impl: { completed: false },
    review: {
      completed: false,
      retryCount: 0,
      lastResolvedRetryCount: 0,
      tool: { completed: false },
      task: { completed: false },
      quality: { completed: false, progress: createEmptyQualityProgress(), baselineDone: false },
    },
  }
}

function createEmptyQualityProgress(): QualityLayerProgress {
  return {
    style: { submitted: false, passed: false },
    architecture: { submitted: false, passed: false },
    performance: { submitted: false, passed: false },
    security: { submitted: false, passed: false },
    maintainability: { submitted: false, passed: false },
  }
}

/** 从 status 派生组级生命状态（替换已删除的 status 字段） */
function deriveStatus(tg: TaskGroupState, currentTaskGroupId: string): OrchestrateStatus {
  if (tg.status === "completed") return "completed"
  if (tg.status === "task_analysis" && tg.id !== currentTaskGroupId && phasesAllEmpty(tg)) return "not_started"
  return "in_progress"
}

function phasesAllEmpty(tg: TaskGroupState): boolean {
  const hasReviewActivity = tg.phases.review.retryCount > 0
  return !tg.phases.architect_review.completed
    && !tg.phases.dev_impl.completed
    && tg.tasks.every((t) => t.status === "open")
    && !tg.phases.review.completed
    && tg.issues.length === 0
    && !hasReviewActivity
}

function hasBlockingIssues(issues: Array<{ severity: string; status?: string }>): boolean {
  return issues.some(
    (i) => (!i.status || i.status === "open" || i.status === "rejected" || i.status === "submitted" || i.status === "exemption") && isBlockingIssue(i)
  )
}

// 单条 issue 是否为阻塞级（Low 及以上；Info 不阻塞）
function isBlockingIssue(i: { severity: string }): boolean {
  return (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
}

function allTasksVerified(tasks: TaskItem[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === "verified")
}

// 存在待确认修复（submitted）或待裁定豁免（exemption）issue 的维度集
function dimsWithPendingAction(tg: TaskGroupState): Set<string> {
  const dims = new Set<string>()
  for (const i of tg.issues) {
    if (i.status === "submitted" || i.status === "exemption") dims.add(i.dimension)
  }
  return dims
}

// 派生本轮需审查的维度集（不持久化）：
// quality.baselineDone=false 时全部维度建基线；修复轮仅含存在 submitted/exemption issue 的维度。
function computeRequiredDims(tg: TaskGroupState): ReviewDimension[] {
  const all = [...REVIEW_DIMENSIONS] as ReviewDimension[]
  if (!tg.phases.review.quality.baselineDone) return all
  const dims = dimsWithPendingAction(tg)
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
const DIMENSION_AGENT_MAP: Record<ReviewDimension, string> = {
  style: "openspec-reviewer-style",
  architecture: "openspec-reviewer-architecture",
  performance: "openspec-reviewer-performance",
  security: "openspec-reviewer-security",
  maintainability: "openspec-reviewer-maintainability",
}

// ─── 阶段门禁：当前可执行角色推导 ───

function deriveCurrentAgents(tg: TaskGroupState): string[] {
  if (tg.status === "task_analysis") return ["openspec-architect"]
  if (tg.status === "dev_impl") return ["openspec-developer"]
  if (tg.status === "review") {
    if (!tg.phases.review.tool.completed) return ["openspec-reviewer-tool"]
    if (!tg.phases.review.task.completed) return ["openspec-reviewer-task"]
    const requiredDims = computeRequiredDims(tg)
    return requiredDims.map((d) => DIMENSION_AGENT_MAP[d])
  }
  return []
}

const AGENT_TO_SUBMIT_TOOL: Record<string, string> = {
  "openspec-architect": "opx_arch_submit",
  "openspec-developer": "opx_dev_submit",
  "openspec-reviewer-tool": "opx_tool_review_submit",
  "openspec-reviewer-task": "opx_task_review_submit",
  "openspec-reviewer-style": "opx_quality_review_submit",
  "openspec-reviewer-architecture": "opx_quality_review_submit",
  "openspec-reviewer-performance": "opx_quality_review_submit",
  "openspec-reviewer-security": "opx_quality_review_submit",
  "openspec-reviewer-maintainability": "opx_quality_review_submit",
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
      // 兼容性检查：旧结构缺少顶层 tasks/issues
      const sampleGroup = state.taskGroups?.[0]
      if (sampleGroup && !('tasks' in sampleGroup)) {
        throw new Error(
          `状态文件 "${state.changeId}" 是旧版本格式，不兼容当前版本。请重新初始化编排会话（opx_orch_init）。`
        )
      }
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

async function getCurrentBranch(worktree: string): Promise<string> {
  const branch = (await runGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
  if (branch === "HEAD") throw new Error("当前处于 detached HEAD 状态，无法自动推断 base_branch。请显式传入 base_branch 参数。")
  return branch
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
  return `- Task id=${t.id} ｜ ${t.title}${trace}`
}

function sortIssuesByCategory(issues: IssueItem[]): IssueItem[] {
  const dimRank = (d: string) => {
    const idx = (REVIEW_DIMENSIONS as readonly string[]).indexOf(d)
    return idx === -1 ? REVIEW_DIMENSIONS.length : idx
  }
  const sevRank = (s: string) => {
    const idx = (SEVERITY_LEVELS as readonly string[]).indexOf(s)
    return idx === -1 ? SEVERITY_LEVELS.length : idx
  }
  return [...issues].sort((a, b) => dimRank(a.dimension) - dimRank(b.dimension) || sevRank(a.severity) - sevRank(b.severity))
}

function renderIssueItem(i: IssueItem): string {
  const lines: string[] = []
  lines.push(`- Issue #${i.id} | ${i.severity} | ${i.dimension} | [${i.sourcePhase}]`)
  lines.push(`  - 文件：${i.file}${i.line > 0 ? `:${i.line}` : ""}`)
  lines.push(`  - 描述：${i.description}`)
  if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
  if (i.status === "exemption" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  if (i.status === "rejected" && i.rejectReason) lines.push(`  - 驳回原因：${i.rejectReason}`)
  lines.push(`  - 修复未过次数：${i.refixCount}`)
  return lines.join("\n")
}

function renderOrchestratorView(state: OrchestrateState, tg: TaskGroupState, diskWorktrees?: { branch: string; path: string }[]): string {
  const ts = taskSummary(tg.tasks)
  const is = issueSummary(tg.issues)
  const lines: string[] = []
  lines.push("# 编排进度", "")
  lines.push(`**变更**: ${state.changeId}`)
  lines.push(`**基准分支**: ${state.baseBranch}`)
  lines.push(`**当前阶段**: ${tg.status}`, "")
  lines.push("## 阶段进展", "")
  lines.push("| 阶段 | 状态 |")
  lines.push("|------|------|")
  const phaseSummary = (name: string, p: { completed: boolean }) => p.completed ? "✓" : (tg.status === name ? "●" : "✗")
  lines.push(`| task_analysis | ${phaseSummary("task_analysis", tg.phases.architect_review)} |`)
  const devStatus = tg.phases.dev_impl.completed ? "✓" : (tg.status === "dev_impl" ? "●" : (tg.status === "review" ? "⭕" : "✗"))
  lines.push(`| dev_impl | ${devStatus} |`)
  const reviewParts: string[] = []
  if (tg.phases.review.tool.completed) reviewParts.push("tool✓")
  if (tg.phases.review.task.completed && !tg.phases.review.tool.completed && allTasksVerified(tg.tasks)) {
    reviewParts.push("task(跳过)")
  } else if (tg.phases.review.task.completed) {
    reviewParts.push("task✓")
  }
  if (tg.phases.review.quality.completed) reviewParts.push("quality✓")
  if (!tg.phases.review.tool.completed) reviewParts.push("tool⏳")
  else if (!tg.phases.review.task.completed) reviewParts.push("task⏳")
  else if (!tg.phases.review.quality.completed) reviewParts.push("quality⏳")
  const reviewLayer = reviewParts.join(" → ")
  const reviewStatus = tg.phases.review.completed ? "✓" : (tg.status === "review" ? `● ${reviewLayer}` : "✗")
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
  const rp = tg.phases.review.quality.progress
  const fmt = (k: ReviewDimension) => `${k}=${rp[k].submitted ? (rp[k].passed ? "passed" : "rejected") : "not_submitted"}`
  lines.push(`| 维度 | 状态 |`)
  lines.push(`|------|------|`)
  for (const dim of ["style", "architecture", "performance", "security", "maintainability"] as const) {
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
      const derivedStatus = existingTg ? deriveStatus(existingTg, state.taskGroupId) : "completed"
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
  if (tg.phases.dev_impl.completed && tg.status === "task_analysis") {
    checks.push(`- ⚠️ 阶段逆序：status=task_analysis 但 dev_impl.completed=true`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "dev_impl", ... } })\``)
  }
  if (tg.phases.review.completed && tg.status !== "review" && tg.status !== "completed") {
    checks.push(`- ⚠️ 阶段逆序：status=${tg.status} 但 review.completed=true`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "review", ... } })\``)
  }
  // 规则 2：缺 worktree
  if ((tg.status === "dev_impl" || tg.status === "review") && !tg.worktreePath) {
    checks.push(`- ⚠️ 缺 worktree：status=${tg.status} 但 worktreePath=null`)
    checks.push(`  建议：先调 opx_orch_set_worktree 创建 worktree，或 \`opx_orch_init({ recovery: { phase: "${tg.status}", worktree_path: "<path>", branch_name: "task-group/${tg.id}" } })\``)
  }
  // 规则 3：缺 executionBoundary
  if ((tg.status === "dev_impl" || tg.status === "review") && !tg.executionBoundary) {
    checks.push(`- ⚠️ 缺 executionBoundary：status=${tg.status} 但 executionBoundary=null`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "task_analysis", ... } })\``)
  }
  // 规则 4：review 内部——quality 维度 passed 但仍有该维度阻塞 issue
  for (const dim of REVIEW_DIMENSIONS) {
    const p = tg.phases.review.quality.progress[dim]
    if (p.passed) {
      const openInDim = tg.issues.filter(
        (i) => i.dimension === dim && (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
      )
      if (openInDim.length > 0) {
        checks.push(`- ⚠️ review 内部矛盾：维度 ${dim} passed 但仍有 ${openInDim.length} 个阻塞 issue`)
        checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "${tg.status === "completed" ? "review" : tg.status}", ... } })\``)
      }
    }
  }
    // 规则 5：检查点待决策态
  if (tg.status === "review") {
    const atCheckpoint = tg.phases.review.retryCount > 0 && tg.phases.review.retryCount % MAX_RETRIES === 0
    const alreadyResolved = tg.phases.review.retryCount === tg.phases.review.lastResolvedRetryCount
    if (atCheckpoint && !alreadyResolved) {
      checks.push(`- ⛔ 审查重试达到检查点（第 ${tg.phases.review.retryCount} 轮），需要用户决策。`)
      checks.push(`  唯一动作：调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`)
    } else if (atCheckpoint && alreadyResolved) {
      checks.push(`- ✅ 检查点已处理（第 ${tg.phases.review.retryCount} 轮后继续），审查正常推进中。`)
    }
  }
  if (checks.length > 0) {
    lines.push(...checks)
    lines.push("")
    lines.push("请用 question 向用户展示上述异常，确认后按对应建议调用 opx_orch_init(recovery=...) 修复。")
  } else {
    lines.push("未发现状态异常。")
  }
  // ── 下一步 ──
  lines.push("", "## 下一步", "")
  if (checks.length > 0) {
    lines.push("以上状态异常，请按 recovery 建议修复。")
  } else if (tg.status === "completed") {
    lines.push("编排已完成。")
  } else if (tg.phases.review.completed) {
    lines.push("所有审核层已完成，调用 `opx_orch_complete_task_group` 收尾。")
  } else if (tg.status === "review") {
    const needsDecision = tg.phases.review.retryCount > 0
      && tg.phases.review.retryCount % MAX_RETRIES === 0
      && tg.phases.review.retryCount !== tg.phases.review.lastResolvedRetryCount
    if (needsDecision) {
      lines.push("审查重试达到检查点（retryCount=" + tg.phases.review.retryCount + "），需要用户决策。")
      lines.push("请调用 `opx_orch_resolve_review` 推进（continue：继续修 / giveup：放弃合并）。")
    } else {
      const agents = deriveCurrentAgents(tg)
      if (agents.length > 0) {
        const agentList = agents.map((a) => `\`${a}\``).join("、")
        lines.push(`分派子代理：${agentList}。`)
        if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
          lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
        }
      } else {
        lines.push("（无待分派项，请检查状态）")
      }
    }
  } else {
    const agents = deriveCurrentAgents(tg)
    if (agents.length > 0) {
      const agentList = agents.map((a) => `\`${a}\``).join("、")
      lines.push(`分派子代理：${agentList}。`)
      if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
        lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
      }
    } else {
      lines.push("（无待分派项，请检查状态）")
    }
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
  const arcReviewLayer = tg.status === "review"
    ? tg.phases.review.tool.completed
      ? tg.phases.review.task.completed
        ? "(quality)"
        : "(task)"
      : "(tool)"
    : ""
  lines.push(`**当前阶段**: ${tg.status}${arcReviewLayer}`, "")
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
  const open = tg.tasks.filter((t) => t.status === "open")
  if (open.length === 0) lines.push("- (无)")
  else for (const t of open) lines.push(renderTaskItem(t))
  lines.push("")
  lines.push("## Issue (申请豁免中)", "")
  const exemption = tg.issues.filter((i) => i.status === "exemption")
  if (exemption.length === 0) lines.push("- (无)")
  else for (const i of exemption) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## Issue (open)", "")
  const openIssues = tg.issues.filter((i) => i.status === "open")
  if (openIssues.length === 0) lines.push("- (无)")
  else for (const i of openIssues) lines.push(renderIssueItem(i))
  return lines.join("\n")
}

function renderDeveloperView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 开发上下文", "")
  lines.push(`当前阶段: ${tg.status}`, "")
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
  // 高 refixCount 阻塞 issue 根因提示
  const highRefixBlocking = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i) && i.refixCount >= 2
  )
  if (highRefixBlocking.length > 0) {
    lines.push("## ⚠️ 修复多次未过的 issue（须根因分析）", "")
    for (const issue of highRefixBlocking) {
      lines.push(`- Issue #${issue.id}（已 ${issue.refixCount} 次修复未过）`)
      lines.push(`  - 文件：${issue.file}${issue.line > 0 ? `:${issue.line}` : ""}`)
      lines.push(`  - 描述：${issue.description}`)
    }
    lines.push("")
    lines.push("**必须完成 5-Why 根因分析后再动手修复**，不得跳过分析直接改代码。", "")
  }
  lines.push("## 相关 spec 文件", "")
  if (tg.relevantSpecs.length === 0) lines.push("- (无)")
  else for (const s of tg.relevantSpecs) lines.push(`- \`openspec/changes/${state.changeId}/specs/${s}/spec.md\``)
  lines.push("")
  lines.push("## Task (待完成)", "")
  const openTasks = tg.tasks.filter((t) => t.status === "open")
  if (openTasks.length === 0) lines.push("- (无)")
  else for (const t of openTasks) lines.push(renderTaskItem(t))
  lines.push("")
  lines.push("## Task (待验证)", "")
  const submitted = tg.tasks.filter((t) => t.status === "submitted")
  if (submitted.length === 0) lines.push("- (无)")
  else for (const t of submitted) lines.push(renderTaskItem(t))
  lines.push("")
  lines.push("## Task (已驳回)", "")
  const rejected = tg.tasks.filter((t) => t.status === "rejected")
  if (rejected.length === 0) lines.push("- (无)")
  else for (const t of rejected) {
    const reason = t.rejectReason ? `  - 驳回原因：${t.rejectReason}` : ""
    lines.push(`${renderTaskItem(t)}${reason ? `\n${reason}` : ""}`)
  }
  lines.push("")
  lines.push("## Issue (待修复 · Low 及以上，必办)", "")
  const blockingIssues = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
  )
  if (blockingIssues.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(blockingIssues)) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## Issue (待修复 · Info，可选，不阻塞提交)", "")
  const infoFix = tg.issues.filter(
    (i) => (i.status === "open" || i.status === "rejected") && !isBlockingIssue(i)
  )
  if (infoFix.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(infoFix)) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## Issue (已修复待验证)", "")
  const submittedIssues = tg.issues.filter((i) => i.status === "submitted")
  if (submittedIssues.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(submittedIssues)) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## Issue (豁免裁定中)", "")
  const exemption = tg.issues.filter((i) => i.status === "exemption")
  if (exemption.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(exemption)) lines.push(renderIssueItem(i))
  return lines.join("\n")
}

function renderToolReviewView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 工具审核上下文", "")
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **diff 范围**: \`${tg.baseRef}..HEAD\``)
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push("")
  lines.push("## 上轮变更文件", "")
  if (tg.lastFilesChanged.length === 0) lines.push("- (无)")
  else for (const f of tg.lastFilesChanged) lines.push(`- \`${f}\``)
  lines.push("")
  lines.push("## 全部 Issue（tool 层可见）", "")
  const allIssues = tg.issues.filter(
    (i) => i.sourcePhase === "tool" && (i.status === "open" || i.status === "submitted" || i.status === "exemption")
  )
  if (allIssues.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(allIssues)) {
    const dimTag = `[${i.dimension}]`
    lines.push(`- ${dimTag} Issue #${i.id} | ${i.severity} | ${i.file}${i.line > 0 ? `:${i.line}` : ""}`)
    lines.push(`  - 描述：${i.description}`)
    if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
    if (i.status === "exemption" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  }
  lines.push("")
  return lines.join("\n")
}

function renderTaskReviewView(state: OrchestrateState, tg: TaskGroupState): string {
  const lines: string[] = []
  lines.push("# 任务审核上下文", "")
  lines.push(`**tool 层**: ${tg.phases.review.tool.completed ? "✓ 已完成" : "⏳ 待完成"}`, "")
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **diff 范围**: \`${tg.baseRef}..HEAD\``)
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push("")
  lines.push("## 上轮变更文件", "")
  if (tg.lastFilesChanged.length === 0) lines.push("- (无)")
  else for (const f of tg.lastFilesChanged) lines.push(`- \`${f}\``)
  lines.push("")
  lines.push("## Task (待验证)", "")
  const submitted = tg.tasks.filter((t) => t.status === "submitted")
  if (submitted.length === 0) lines.push("- (无)")
  else for (const t of submitted) lines.push(renderTaskItem(t))
  lines.push("")
  lines.push("## Task (已驳回)", "")
  const rejected = tg.tasks.filter((t) => t.status === "rejected")
  if (rejected.length === 0) lines.push("- (无)")
  else for (const t of rejected) {
    const reason = t.rejectReason ? `  - 驳回原因：${t.rejectReason}` : ""
    lines.push(`${renderTaskItem(t)}${reason ? `\n${reason}` : ""}`)
  }
  lines.push("")
  const taskIssues = tg.issues.filter(
    (i) => i.sourcePhase === "task" && (i.status === "open" || i.status === "submitted" || i.status === "exemption")
  )
  if (taskIssues.length > 0) {
    lines.push("## 审查 Issue", "")
    for (const i of taskIssues) lines.push(renderIssueItem(i))
    lines.push("")
  }
  return lines.join("\n")
}

function renderQualityReviewView(state: OrchestrateState, tg: TaskGroupState, agent: string): string {
  const dimension = (Object.keys(DIMENSION_AGENT_MAP) as Dimension[]).find((d) => DIMENSION_AGENT_MAP[d] === agent) || ""
  const lines: string[] = []
  lines.push(`# AI 审查上下文 — ${dimension}`, "")
  lines.push(`**task 层**: ${tg.phases.review.task.completed ? "✓ 已完成" : "⏳ 待完成"}`, "")
  lines.push("## Worktree", "")
  if (tg.worktreePath) {
    lines.push(`- **路径**: \`${tg.worktreePath}\``)
    lines.push(`- **分支**: \`${tg.branchName || "(none)"}\``)
    if (tg.baseRef) lines.push(`- **diff 范围**: \`${tg.baseRef}..HEAD\``)
  } else {
    lines.push("- (worktree 尚未设置)")
  }
  lines.push("")
  lines.push("## 上轮变更文件", "")
  if (tg.lastFilesChanged.length === 0) lines.push("- (无)")
  else for (const f of tg.lastFilesChanged) lines.push(`- \`${f}\``)
  lines.push("")
  lines.push(
    "> 回归排查：对照上述「上轮变更文件」，检查本次修复是否在本维度引入了新问题；发现即在本维度报新 issue。",
    ""
  )
  const openIssues = tg.issues.filter(
    (i) => i.sourcePhase === "quality" && i.dimension === dimension && i.status === "open"
  )
  lines.push("## 本维度 Issue (open)", "")
  if (openIssues.length === 0) lines.push("- (无)")
  else for (const i of openIssues) lines.push(renderIssueItem(i))
  lines.push("")
  const submittedIssues = tg.issues.filter(
    (i) => i.sourcePhase === "quality" && i.dimension === dimension && i.status === "submitted"
  )
  lines.push("## 本维度 Issue (待确认)", "")
  if (submittedIssues.length === 0) lines.push("- (无)")
  else for (const i of submittedIssues) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push(
    "> 存量确认：逐条核验上述「待确认」issue 是否真已修复——已修复列入 fixed_issue_ids；未达标则不列入，工具将自动回退为 rejected 交 developer 重修。",
    ""
  )
  const exemptionIssues = tg.issues.filter(
    (i) => i.sourcePhase === "quality" && i.dimension === dimension && i.status === "exemption"
  )
  lines.push("## 本维度 Issue (豁免裁定中)", "")
  if (exemptionIssues.length === 0) lines.push("- (无)")
  else for (const i of exemptionIssues) lines.push(renderIssueItem(i))
  return lines.join("\n")
}

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_init
// ═══════════════════════════════════════════════════════════

const PHASE_ORDER: Phase[] = ["task_analysis", "dev_impl", "review"]

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。同 changeId 可重复调用，仅重建目标组，其余组原样保留。",
  args: {
    change_id: tool.schema.string().min(1).describe("OpenSpec 变更 ID"),
    task_group_id: tool.schema.string().min(1).describe("要初始化的任务组 ID。仅此组被重建（in_progress），其余组原样保留。"),
    base_branch: tool.schema.string().optional().describe("基准分支名（如 main、develop），用于计算 merge-base 和 worktree fork 源。未传则自动从当前 git 分支推导。"),
    recovery: tool.schema.object({
      phase: tool.schema.enum(PHASE_ORDER).describe("恢复到哪个阶段"),
      worktree_path: tool.schema.string().min(1).describe("已有 worktree 的绝对路径"),
      branch_name: tool.schema.string().min(1).describe("worktree 对应的分支名（如 task-group/3）"),
      preserve_progress: tool.schema.boolean().default(true).optional().describe("是否保留阶段内进度（task/issue 状态）。true 时只修阶段错位、不动阶段内明细；false 时按 phase 重置全部 task/issue 进度。默认 true。"),
      review_layer: tool.schema
        .enum(["tool", "task", "quality"])
        .optional()
        .describe("恢复到 review 内某子层（仅 phase=review 时有效）。tool→从 tool 层开始（默认），task→tool 层标记完成从 task 层开始，quality→tool+task 层完成从 quality 层开始"),
    }).optional().describe("进度恢复参数。提供后按 phase 恢复阶段状态，< phase 为 completed，== phase 为 in_progress，> phase 为 not_started。"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_init")

    // 兜底：若 recovery 参数被模型序列化为字符串，自动解析
    if (typeof args.recovery === "string") {
      try { args.recovery = JSON.parse(args.recovery) as any } catch {
        throw new Error(`recovery 参数解析失败：传入的字符串无法解析为对象。传入值：${args.recovery}`)
      }
    }

    if (args.recovery?.review_layer && args.recovery.phase !== "review") {
      throw new Error("review_layer 参数仅当 recovery.phase 为 review 时有效，当前 phase 为 \"" + args.recovery.phase + "\"。")
    }

    const parsedGroups = await parseAllTaskGroupsFromMd(context.worktree, args.change_id)
    if (parsedGroups.length === 0) {
      throw new Error(`无法从 tasks.md 解析出任务组，请检查文件 openspec/changes/${args.change_id}/tasks.md。`)
    }
    const targetGroup = parsedGroups.find((g) => g.id === args.task_group_id)
    if (!targetGroup) {
      throw new Error(`task_group_id "${args.task_group_id}" 不在 tasks.md 中。可用 ID: [${parsedGroups.map((g) => g.id).join(", ")}]。`)
    }

    // 解析当前任务组的子任务
    const parsedTasks = await parseTasksMdForGroup(context.worktree, args.change_id, args.task_group_id)
    const relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
    const newTasks: TaskItem[] = parsedTasks.map((p, i) => ({
      id: String(i + 1),
      tasksMdRef: p.tasksMdRef,
      specTrace: p.specTrace,
      title: p.title,
      status: "open" as const,
      taskNumber: p.taskNumber,
      rejectReason: null,
    }))

    function buildPhases(
      targetPhase: BuildPhaseTarget | null,
      reviewLayer?: "tool" | "task" | "quality"
    ): { phases: Phases; status: BuildPhaseTarget } {
      if (!targetPhase) return { phases: createEmptyPhases(), status: "task_analysis" }
      const phases = createEmptyPhases()
      let found = false
      for (const p of PHASE_ORDER) {
        if (p === targetPhase) { found = true; continue }
        if (!found) {
          if (p === "dev_impl") {
            phases.dev_impl = { completed: true }
          } else if (p === "review") {
            phases.review.completed = true
          } else {
            phases.architect_review = { completed: true }
          }
        }
      }
      // Handle review_layer sub-phase recovery
      if (targetPhase === "review" && reviewLayer) {
        if (reviewLayer === "task" || reviewLayer === "quality") {
          phases.review.tool.completed = true
        }
        if (reviewLayer === "quality") {
          phases.review.task.completed = true
        }
      }
      return { phases, status: targetPhase }
    }

    const taskInjectionStatus: TaskStatus = args.recovery?.phase === "review" ? "verified" : "open"

    let state = await readStateByChangeId(context.worktree, args.change_id)
    const baseBranch = args.base_branch || await getCurrentBranch(context.worktree)
    if (state) {
      state.baseBranch = state.baseBranch || baseBranch
      const existingMap = new Map(state.taskGroups.map((g) => [g.id, g]))
      state.taskGroups = parsedGroups.map((p) => {
        const existing = existingMap.get(p.id)

        if (p.id !== args.task_group_id) {
          // Non-current group: preserve existing, or add new as not_started
          if (existing) {
            return { ...existing, name: p.name, taskCount: p.taskCount }
          }
          return {
            id: p.id, name: p.name, taskCount: p.taskCount,
            status: "task_analysis" as Phase,
            worktreePath: null, branchName: null, baseRef: null,
            executionBoundary: null,
            relevantSpecs: [], lastFilesChanged: [],
            phases: createEmptyPhases(),
            tasks: [],
            issues: [],
          }
        }

        // Current group: rebuild
        const defaultPhase = args.recovery ? args.recovery.phase : "task_analysis"
        const phases = args.recovery
          ? buildPhases(args.recovery.phase as BuildPhaseTarget, args.recovery?.review_layer).phases
          : buildPhases("task_analysis").phases
        const preserveProgress = args.recovery?.preserve_progress !== false
        let tgTasks: TaskItem[]
        let tgIssues: IssueItem[]
        if (existing && args.recovery && preserveProgress) {
          tgTasks = newTasks.map((t) => {
            const existingTask = existing.tasks.find((et) => et.id === t.id)
            return existingTask || { ...t, status: taskInjectionStatus }
          })
          tgIssues = [...existing.issues]
          // 保留 review layer 进度
          phases.review.retryCount = existing.phases.review.retryCount
          phases.review.quality.baselineDone = existing.phases.review.quality.baselineDone
          phases.review.tool = existing.phases.review.tool
          phases.review.task = existing.phases.review.task
          phases.review.quality = existing.phases.review.quality
        } else {
          tgTasks = newTasks.map((t) => ({
            ...t,
            status: taskInjectionStatus,
          }))
          tgIssues = existing?.issues ?? []
          if (existing && args.recovery) {
            phases.review.retryCount = existing.phases.review.retryCount
            phases.review.quality.baselineDone = existing.phases.review.quality.baselineDone
            phases.review.tool = existing.phases.review.tool
            phases.review.task = existing.phases.review.task
            phases.review.quality = existing.phases.review.quality
          }
        }

        // review_layer 必须在 preserve_progress 之后应用，避免被 existing 值覆盖
        if (args.recovery?.phase === "review" && args.recovery?.review_layer) {
          const rl = args.recovery.review_layer
          if (rl === "task" || rl === "quality") {
            phases.review.tool.completed = true
          }
          if (rl === "quality") {
            phases.review.task.completed = true
            phases.review.retryCount = 0
            phases.review.quality.progress = createEmptyQualityProgress()
            phases.review.quality.baselineDone = false
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
          tasks: tgTasks,
          issues: tgIssues,
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
      state.taskGroupId = args.task_group_id
    } else {
      state = {
        changeId: args.change_id,
        taskGroupId: args.task_group_id,
        baseBranch,
        taskGroups: parsedGroups.map((p) => {
          const isCurrent = p.id === args.task_group_id
          const defaultPhase = args.recovery ? args.recovery.phase : "task_analysis"
          const { phases, status } = isCurrent
            ? buildPhases(args.recovery ? (args.recovery.phase as BuildPhaseTarget) : "task_analysis", args.recovery?.review_layer)
            : { phases: createEmptyPhases(), status: "task_analysis" as Phase }
          return {
            id: p.id, name: p.name, taskCount: p.taskCount,
            status,
            worktreePath: null, branchName: null, baseRef: null,
            executionBoundary: null,
            relevantSpecs: isCurrent ? relevantSpecs : [],
            lastFilesChanged: [],
            phases,
            tasks: isCurrent
              ? newTasks.map((t) => ({ ...t, status: taskInjectionStatus }))
              : [],
            issues: [],
          }
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

    // recovery 写入 worktree 信息 + baseRef + diff
    const ctg = findTaskGroup(state, args.task_group_id)
    if (args.recovery) {
      ctg.worktreePath = args.recovery.worktree_path
      ctg.branchName = args.recovery.branch_name
      if (args.recovery.phase !== "task_analysis" && !args.recovery.worktree_path) {
        throw new Error(
          `recovery 缺少 worktree_path，无法获取 merge-base。请提供有效 worktree 路径。`
        )
      }
      const baseRef = await getMergeBase(args.recovery.worktree_path, baseBranch)
      if (!baseRef) throw new Error(`无法获取 worktree 与 ${baseBranch} 的 merge-base：${args.recovery.worktree_path}`)
      ctg.baseRef = baseRef
      const recoveryIdx = PHASE_ORDER.indexOf(args.recovery.phase)
      const reviewIdx = PHASE_ORDER.indexOf("review")
      if (recoveryIdx >= reviewIdx) {
        ctg.lastFilesChanged = await getDiffFileList(args.recovery.worktree_path, baseRef)
      }

      // Auto-fill executionBoundary for dev_impl/review recovery when missing
      if ((args.recovery.phase === "dev_impl" || args.recovery.phase === "review") && !ctg.executionBoundary) {
        const diffFiles = recoveryIdx >= reviewIdx
          ? ctg.lastFilesChanged
          : await getDiffFileList(args.recovery.worktree_path, baseRef)
        const dirs = [...new Set(diffFiles.map((f) => {
          const d = path.dirname(f)
          return d === "." ? f : d
        }).filter(Boolean))]
        ctg.executionBoundary = {
          allowed_directories: dirs.length > 0 ? dirs : ["."],
          allowed_packages: [],
          notes: "(恢复时自动生成)",
        }
      }
    }

    await writeState(context.worktree, state)

    const recoveryMsg = args.recovery
      ? `已恢复到 ${args.recovery.phase} 阶段。worktree=${args.recovery.branch_name}，baseRef=${ctg.baseRef?.slice(0, 7)}。`
      : ""
    const defaultPhase = args.recovery ? args.recovery.phase : "task_analysis"
    let nextStep = ""
    if (defaultPhase === "task_analysis" && ctg.phases.architect_review.completed) {
      nextStep = "架构师复核已通过。请调用 opx_orch_set_worktree 设置 worktree 后分派 openspec-developer。"
    } else if (defaultPhase === "task_analysis") nextStep = "请分派 openspec-architect 子代理。"
    else if (defaultPhase === "dev_impl" || defaultPhase === "review") nextStep = "请先调用 opx_orch_set_worktree 确保 worktree 就绪，再分派子代理。"
    return JSON.stringify(
      {
        status: "initialized",
        change_id: state.changeId,
        task_group_count: state.taskGroups.length,
        current_task_group: targetGroup,
        active_phase: defaultPhase,
        task_count: newTasks.length,
        message: `编排会话已初始化。${recoveryMsg}${nextStep}`,
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
    "确保目标组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{id}，路径 .worktree/task-group-{id}）。架构师复核通过后调用。进入开发阶段时自动按最终 tasks.md 刷新当前组任务列表；恢复场景仅补齐 worktree、不改阶段。",
  args: {
    worktree_path: tool.schema.string().optional().describe("git worktree 的绝对路径（可选，不传则按规范自动生成）"),
    branch_name: tool.schema.string().optional().describe("worktree 对应的分支名（可选，不传则按规范 task-group/{id}）"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_set_worktree")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
    if (!tg.phases.architect_review.completed) {
      throw new Error(`阶段顺序错误：opx_orch_set_worktree 需在 architect_review 完成后调用，当前 architect_review 阶段状态为 "uncompleted"。`)
    }

    const repoRoot = context.worktree
    const branch = args.branch_name || `task-group/${state.taskGroupId}`
    const wtPath = args.worktree_path || path.join(repoRoot, ".worktree", `task-group-${state.taskGroupId}`)

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
    if (tg.status === "task_analysis") {
      const isTasksEmpty = tg.tasks.length === 0
      const allOpen = tg.tasks.every((t) => t.status === "open")
      if (!isTasksEmpty && !allOpen) {
        throw new Error(
          `进入开发阶段时当前组 task 列表异常（非空且非全部 open），无法安全刷新。` +
          `请检查 state 文件 ${state.changeId} 是否与 tasks.md 一致。`
        )
      }
      if (isTasksEmpty || allOpen) {
        const parsedTasks = await parseTasksMdForGroup(context.worktree, state.changeId, state.taskGroupId)
        const newRelevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
        tg.tasks = parsedTasks.map((p, i) => ({
          id: String(i + 1),
          tasksMdRef: p.tasksMdRef,
          specTrace: p.specTrace,
          title: p.title,
          status: "open" as TaskStatus,
          taskNumber: p.taskNumber,
          rejectReason: null,
        }))
        tg.relevantSpecs = newRelevantSpecs
      }
      tg.phases.dev_impl.completed = false
      tg.status = "dev_impl"
    }

    await writeState(context.worktree, state)

    const msg = reused
      ? `复用已有 worktree：${existingPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
      : `已创建 worktree：${wtPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
    const next = tg.status === "dev_impl"
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
    "统一只读状态/上下文查询。按调用者角色路由：orchestrator→统计+worktree；architect→spec/task/issue；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度存量 issue。",
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

    const tg = findTaskGroup(state, state.taskGroupId)

    // Phase gate: 非 orchestrator 角色必须匹配当前可执行角色
    if (agent !== ORCHESTRATOR_AGENT) {
      const expected = deriveCurrentAgents(tg)
      if (!expected.includes(agent)) {
        return [
          "# ⛔ 阶段门禁",
          "",
          `当前阶段为 **${tg.status}**，未轮到你（**${agent}**）执行。`,
          `当前预期角色为：\`${expected.join(", ") || "(无)"}\``,
          "",
          "请立即结束当前会话，不要执行任何操作。",
        ].join("\n")
      }
    }

    // 兜底：baseline 已建但无待审维度 — 自动收尾
    if (
      tg.status === "review" &&
      tg.phases.review.quality.baselineDone &&
      !tg.phases.review.quality.completed &&
      deriveCurrentAgents(tg).length === 0
    ) {
      tg.phases.review.quality.completed = true
      tg.phases.review.completed = true
      await writeState(context.worktree, state)
    }

    let view: string
    if (agent === ORCHESTRATOR_AGENT) {
      const diskWts = await discoverDiskWorktrees(context.worktree)
      view = renderOrchestratorView(state, tg, diskWts)
    } else if (agent === "openspec-architect") {
      view = renderArchitectView(state, tg)
    } else if (agent === "openspec-developer") {
      view = renderDeveloperView(state, tg)
    } else if (agent === "openspec-reviewer-tool") {
      view = renderToolReviewView(state, tg)
    } else if (agent === "openspec-reviewer-task") {
      view = renderTaskReviewView(state, tg)
    } else if (Object.values(DIMENSION_AGENT_MAP).includes(agent)) {
      view = renderQualityReviewView(state, tg, agent)
    } else {
      view = renderOrchestratorView(state, tg)
    }

    // 通过 gate 检查的非 orchestrator 角色：注入提交指令块
    if (agent !== ORCHESTRATOR_AGENT) {
      const submitTool = AGENT_TO_SUBMIT_TOOL[agent] || "对应 submit 工具"
      const instructionBlock = [
        "# ✅ 当前轮到你执行",
        "",
        `完成本职工作后**必须**调用 \`${submitTool}(task_group_id="${tg.id}")\` 提交。`,
        "即使无 issue / 无待处理项，也必须提交 passed=true。",
        "",
        "---",
        "",
      ].join("\n")
      view = instructionBlock + view
    }

    return view
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_complete_task_group
// ═══════════════════════════════════════════════════════════

export const complete_task_group = tool({
  description:
    "完成任务组收尾：合并 task-group 分支到 baseBranch → 清理 worktree 与分支。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
  args: {},
  async execute(_args, context) {
    assertOrchestrator(context, "opx_orch_complete_task_group")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
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
    const openIssues = tg.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
    )
    if (openIssues.length > 0) {
      throw new Error(`存在 ${openIssues.length} 个 Low 及以上的 open/rejected issue 未处理，请先修复或申请豁免。`)
    }
    const openTasks = tg.tasks.filter(
      (t) => t.status === "open" || t.status === "submitted" || t.status === "rejected"
    )
    if (openTasks.length > 0) {
      throw new Error(`存在 ${openTasks.length} 个未完成 task。`)
    }
    // 合并分支到 baseBranch
    const mergeTarget = state.baseBranch
    if (tg.branchName) {
      const mergeResult = await mergeBranchToTarget(context.worktree, tg.branchName, mergeTarget)
      if (!mergeResult.success) {
        return JSON.stringify(
          {
            status: "blocked",
            merge_conflict: true,
            message:
              `合并到 "${mergeTarget}" 时发生冲突，已中止合并。` +
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
    await writeState(context.worktree, state)
    return JSON.stringify(
      {
        status: "ok",
        completed_task_group: tg.id,
        merge_target: mergeTarget,
        message: `任务组已完成并合并到 "${mergeTarget}"。`,
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
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "task_analysis") {
      throw new Error(`阶段顺序错误：task_analysis 当前不在活跃阶段，当前阶段为 "${tg.status}"。`)
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
//  工具: opx_dev_submit
// ═══════════════════════════════════════════════════════════

const requestExemptItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("申请豁免的 issue ID"),
  reason: tool.schema.string().min(1).describe("豁免理由"),
})

const rejectedIssueItem = tool.schema.object({
  issue_id: tool.schema.string().min(1).describe("驳回的 issue ID"),
  reason: tool.schema.string().min(1).describe("驳回原因"),
})

export const dev_submit = tool({
  description:
    "developer 提交实现结果。根据 status 区分 task 提交还是 issue 修复：\n" +
    "- dev_impl 阶段：标记 task 为 submitted，自动进入 review 阶段\n" +
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
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "dev_impl" && tg.status !== "review") {
      throw new Error(`dev_submit 仅在 dev_impl 或 review 阶段可用，当前阶段为 "${tg.status}"。`)
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

    // 统一处理：标记 open/rejected task 为 submitted
    for (const task of tg.tasks) {
      if (task.status === "open" || task.status === "rejected") task.status = "submitted"
    }
    // 完成度门禁：不允许残留 open/rejected task
    const remainingTasks = tg.tasks.filter(
      (t) => t.status === "open" || t.status === "rejected"
    )
    if (remainingTasks.length > 0) {
      throw new Error(
        `存在 ${remainingTasks.length} 个 open/rejected task 未完成，无法提交：` +
          remainingTasks.map((t) => `#${t.id} ${t.title}`).join("; ")
      )
    }

    // 处理 fixed_issue_ids
    let touchedAnyIssue = false
    const fixedIds = args.fixed_issue_ids || []
    for (const id of fixedIds) {
      const issue = tg.issues.find((i) => i.id === id)
      if (issue && (issue.status === "open" || issue.status === "rejected")) {
        issue.status = "submitted"
        touchedAnyIssue = true
      }
    }

    // 处理 request_exempts
    const requestedIds: string[] = []
    for (const r of args.request_exempts || []) {
      const issue = tg.issues.find((i) => i.id === r.issue_id)
      if (!issue) throw new Error(`issue #${r.issue_id} 不在任务组 ${args.task_group_id} 的 issue 清单中。`)
      if (issue.status === "exempted") {
        throw new Error(`issue #${r.issue_id} 已被豁免，无需重复申请。`)
      }
      if (issue.status === "rejected") {
        throw new Error(`issue #${r.issue_id} 的豁免申请已被驳回，必须修复，不可二次申请豁免。`)
      }
      if (issue.status === "verified") {
        throw new Error(`issue #${r.issue_id} 已通过验证，无需申请豁免。`)
      }
      issue.status = "exemption"
      issue.exemptReason = r.reason
      requestedIds.push(r.issue_id)
      touchedAnyIssue = true
    }

    // 完成度门禁：Low 及以上的 open/rejected issue 必须全部修复或申请豁免（Info 可残留）
    const remainingBlocking = tg.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && isBlockingIssue(i)
    )
    if (remainingBlocking.length > 0) {
      throw new Error(
        `存在 ${remainingBlocking.length} 个 Low 及以上的 open/rejected issue 未处理，无法提交（请逐条修复或申请豁免）：` +
          remainingBlocking.map((i) => `#${i.id}(${i.severity}/${i.dimension})`).join("; ")
      )
    }

    // 选项 Y 决策
    if (touchedAnyIssue) {
      // 重置 review 三层
      tg.phases.review.tool.completed = false
      tg.phases.review.task.completed = false
      tg.phases.review.quality.completed = false
      tg.phases.review.quality.progress = createEmptyQualityProgress()
      tg.status = "review"
      requiredDims = computeRequiredDims(tg)
      nextMsg = "请分派各 reviewer 重新审查\n将从 tool 层重新开始审核"
    } else {
      tg.phases.dev_impl.completed = true
      tg.status = "review"
      requiredDims = computeRequiredDims(tg)
      nextMsg = "请分派 openspec-reviewer-tool 开始 tool review"
    }

    // 自动跳过：baseline 已完成且本轮无待审维度
    if (tg.phases.review.quality.baselineDone && requiredDims.length === 0) {
      tg.phases.review.quality.completed = true
      tg.phases.review.completed = true
    }

    // 跳过判定：修复轮无待验证 task 时跳过 task review
    if (allTasksVerified(tg.tasks)) {
      tg.phases.review.task.completed = true
      nextMsg = "本轮无待验证 task，task 层已自动通过。tool review 完成后直接进入 quality review。"
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
//  共享审核下层 helper
// ═══════════════════════════════════════════════════════════

const taskVerifyItem = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID（task 清单中 task 项的 id）"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

const toolIssueItem = tool.schema.object({
  dimension: tool.schema.enum(CODE_DIMENSIONS).describe("issue 所属维度（5 维之一）"),
  severity: tool.schema.enum(SEVERITY_LEVELS).describe("严重级别"),
  file: tool.schema.string().min(1).describe("问题所在文件路径"),
  line: tool.schema.number().int().min(0).describe("问题所在行号（0=整文件/待新建文件，如 tool 改进 issue 指向待建配置文件）"),
  description: tool.schema.string().min(1).describe("问题描述"),
  suggestion: tool.schema.string().optional().describe("修复建议"),
})

/** 确定性去重：dimension+file+line+description 全等匹配时跳过（仅与 open/submitted/rejected 状态比对） */
function mergeExecutionBoundary(tg: TaskGroupState, expansion: { allowed_directories?: string[]; allowed_packages?: string[] }): void {
  if (!tg.executionBoundary) return
  const { allowed_directories, allowed_packages } = expansion
  if (allowed_directories) {
    for (const dir of allowed_directories) {
      if (!tg.executionBoundary.allowed_directories.includes(dir)) {
        tg.executionBoundary.allowed_directories.push(dir)
      }
    }
  }
  if (allowed_packages) {
    for (const pkg of allowed_packages) {
      if (!tg.executionBoundary.allowed_packages.includes(pkg)) {
        tg.executionBoundary.allowed_packages.push(pkg)
      }
    }
  }
}

function deduplicateAndAddIssues(
  issues: any[],
  existingIssues: IssueItem[],
  dimension: Dimension,
  sourcePhase: "tool" | "task" | "quality",
  nextIssueIdStart: number,
): { newIssues: IssueItem[]; nextIssueId: number; dedupedCount: number } {
  let nextIssueId = nextIssueIdStart
  let dedupedCount = 0
  const newIssues: IssueItem[] = []
  for (const iss of issues) {
    const isDuplicate = existingIssues.some(
      (existing) =>
        existing.dimension === dimension &&
        existing.file === iss.file &&
        existing.line === iss.line &&
        existing.description === iss.description &&
        (existing.status === "open" || existing.status === "submitted" || existing.status === "rejected")
    )
    if (isDuplicate) { dedupedCount++; continue }
    newIssues.push({
      id: String(nextIssueId++),
      dimension: dimension,
      severity: iss.severity,
      file: iss.file,
      line: iss.line,
      description: iss.description,
      suggestion: iss.suggestion || "",
      status: "open" as const,
      refixCount: 0,
      rootCauseGuess: null,
      exemptReason: null,
      rejectReason: null,
      sourcePhase,
    })
  }
  return { newIssues, nextIssueId, dedupedCount }
}

/**
 * 统一 issue 裁定门禁 —— 所有活跃 issue（submitted ∪ exemption）必须被显式裁定
 * 覆盖项：fixed_issue_ids→verified，exempt_issue_ids→exempted，rejected_issue_ids→rejected（写入 reason）
 * 遗漏则 fail-fast 报错
 * dimension? 可选过滤（quality 维度使用，task/tool 层不需要）
 */
function applyReviewGate(
  issues: IssueItem[],
  fixedIds: string[],
  exemptIds: string[],
  rejectedIssueInputs: Array<{ issue_id: string; reason: string }>,
  dimension?: Dimension,
  sourcePhase?: string
): void {
  const filtered = dimension
    ? issues.filter((i) => (i.status === "submitted" || i.status === "exemption") && i.dimension === dimension && i.sourcePhase === sourcePhase)
    : issues.filter((i) => (i.status === "submitted" || i.status === "exemption") && i.sourcePhase === sourcePhase)

  const fixedSet = new Set(fixedIds)
  const exemptSet = new Set(exemptIds)
  const rejectedSet = new Set(rejectedIssueInputs.map((r) => r.issue_id))

  // 冲突校验：同一 id 不可出现在多个列表
  for (const id of fixedIds) {
    if (exemptSet.has(id)) throw new Error(`issue #${id} 同时出现在 fixed_issue_ids 和 exempt_issue_ids 中。`)
    if (rejectedSet.has(id)) throw new Error(`issue #${id} 同时出现在 fixed_issue_ids 和 rejected_issue_ids 中。`)
  }
  for (const id of exemptIds) {
    if (rejectedSet.has(id)) throw new Error(`issue #${id} 同时出现在 exempt_issue_ids 和 rejected_issue_ids 中。`)
  }

  // 单列表重复校验
  const seenInRejected = new Set<string>()
  for (const r of rejectedIssueInputs) {
    if (seenInRejected.has(r.issue_id)) throw new Error(`rejected_issue_ids 中存在重复的 issue ID：${r.issue_id}。`)
    seenInRejected.add(r.issue_id)
  }

  // 异常校验：状态与列表不匹配
  for (const id of fixedIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status !== "submitted") {
      throw new Error(`issue #${id} 状态为 ${issue.status}，不可通过 fixed_issue_ids 标记 verified（仅 submitted 可标记）。`)
    }
  }
  for (const id of exemptIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status !== "exemption") {
      throw new Error(`issue #${id} 状态为 ${issue.status}，不可通过 exempt_issue_ids 豁免（仅 exemption 可豁免）。`)
    }
  }

  // 完整性门禁：所有活跃 issue 必须被覆盖
  const uncovered = filtered.filter((i) => !fixedSet.has(i.id) && !exemptSet.has(i.id) && !rejectedSet.has(i.id))
  if (uncovered.length > 0) {
    throw new Error(
      `以下 ${uncovered.length} 个活跃 issue（submitted/exemption）未被 fixed_issue_ids、exempt_issue_ids 或 rejected_issue_ids 覆盖：` +
      uncovered.map((i) => `#${i.id}(${i.status})`).join(", ") +
      `。所有活跃 issue 必须有明确裁定。`
    )
  }

  // 执行裁定
  for (const id of fixedIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status === "submitted") {
      issue.status = "verified"
    }
  }
  for (const id of exemptIds) {
    const issue = issues.find((i) => i.id === id)
    if (issue && issue.status === "exemption") {
      issue.status = "exempted"
      if (!issue.exemptReason) issue.exemptReason = "(由审核者豁免)"
    }
  }
  for (const r of rejectedIssueInputs) {
    const issue = issues.find((i) => i.id === r.issue_id)
    if (issue && (issue.status === "submitted" || issue.status === "exemption")) {
      const wasSubmitted = issue.status === "submitted"
      issue.status = "rejected"
      issue.rejectReason = r.reason
      if (wasSubmitted) issue.refixCount++
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  工具: opx_tool_review_submit
// ═══════════════════════════════════════════════════════════

export const tool_review_submit = tool({
  description:
    "工具审核层提交。跨维提交 tool issues（issues 自带 dimension 字段），含 UT 结果。调用者必须为 openspec-reviewer-tool。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    passed: tool.schema.boolean().describe("工具层是否通过"),
    issues: tool.schema.array(toolIssueItem).optional().describe("跨维 issue，每个 item 需带 dimension"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    test_results: tool.schema.string().optional().describe("UT 运行结果摘要"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_tool_review_submit", ["openspec-reviewer-tool"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`tool_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
    }
    if (tg.phases.review.tool.completed) {
      throw new Error("tool 层审核报告已提交，不允许重复提交。")
    }
    if ((tg.phases.review.task.completed && !allTasksVerified(tg.tasks)) || tg.phases.review.quality.completed) {
      throw new Error("后续层审核报告已提交，tool 层不可再提交。")
    }
    assertPassWithIssues(args.passed, args.issues || [], "opx_tool_review_submit")

    const issues = (args.issues || []) as any[]
    // 校验每个 issue 必须有 dimension 字段且属于 5 维
    for (const iss of issues) {
      if (!iss.dimension || !REVIEW_DIMENSIONS.includes(iss.dimension)) {
        throw new Error(`tool issue 必须包含有效的 dimension 字段（5 维之一），收到：${iss.dimension}。`)
      }
    }

    // 处理 issue 裁定（fixed→verified / exempt→exempted / rejected→rejected），维度不限
    applyReviewGate(tg.issues, args.fixed_issue_ids || [], args.exempt_issue_ids || [], args.rejected_issue_ids || [], undefined, "tool")

    // 添加新 issue（去重）
    let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
    const newIssues: IssueItem[] = []
    let dedupedCount = 0
    for (const iss of issues) {
      const dim = iss.dimension as Dimension
      const dedupResult = deduplicateAndAddIssues([iss], tg.issues, dim, "tool", nextIssueId)
      if (dedupResult.dedupedCount > 0) { dedupedCount++; continue }
      if (dedupResult.newIssues.length > 0) {
        newIssues.push(dedupResult.newIssues[0])
        nextIssueId = dedupResult.nextIssueId
      }
    }
    tg.issues.push(...newIssues)

    // 合并执行边界
    if (tg.executionBoundary && newIssues.length > 0) {
      const dirs = tg.executionBoundary.allowed_directories
      for (const iss of newIssues) {
        const dir = path.dirname(iss.file)
        const entry = dir === "" || dir === "." ? iss.file : dir
        if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
      }
    }

    // 合并执行边界（reviewer 显式声明扩展，仅 passed=false）
    if (tg.executionBoundary && args.boundary_expansion) {
      if (args.passed) {
        throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
      }
      mergeExecutionBoundary(tg, args.boundary_expansion)
    }

    tg.phases.review.tool.completed = true
    if (args.test_results) tg.phases.review.tool.testResults = args.test_results
    await writeState(context.worktree, state)

    const hasBlocking = hasBlockingIssues(tg.issues)
    if (args.passed && !hasBlocking) {
      return JSON.stringify({
        status: "ok",
        phase: "review(tool=completed)",
        message: `tool 层审核通过。${
          dedupedCount > 0 ? `${dedupedCount} 个重复 issue 已自动跳过；` : ""
        }进入 task review 层。请分派 openspec-reviewer-task。`,
      })
    }

    tg.phases.review.retryCount++
    const retryCount = tg.phases.review.retryCount
    if (retryCount > 0 && retryCount % MAX_RETRIES === 0) {
      await writeState(context.worktree, state)
      return JSON.stringify({
        status: "needs_user_decision",
        layer: "tool",
        retry_count: retryCount,
        message: `审查重试达到检查点（第 ${retryCount} 轮）。请编排者调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`,
      })
    }
    tg.phases.review.tool.completed = false
    tg.status = "dev_impl"
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "rejected",
      phase: "review→dev_impl",
      retry_count: retryCount,
      layer: "tool",
      message: `tool 层审核不通过（第 ${retryCount} 轮）。请分派 openspec-developer 修复后重新提交。将从 tool 层重新开始审核。`,
    })
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_task_review_submit
// ═══════════════════════════════════════════════════════════

const taskVerifyResult = tool.schema.object({
  task_id: tool.schema.string().min(1).describe("子任务 ID"),
  reason: tool.schema.string().min(1).describe("失败理由"),
})

export const task_review_submit = tool({
  description:
    "任务审核层提交。验证 task 产出、服务启动、接口可用性、测试代码审查。调用者必须为 openspec-reviewer-task。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    passed: tool.schema.boolean().describe("任务层是否通过"),
    verified_task_ids: tool.schema.array(tool.schema.string()).optional().describe("已验证完成的 task ID 列表"),
    failed_task_ids: tool.schema.array(taskVerifyResult).optional().describe("未完成的 task 列表（含原因）"),
    issues: tool.schema.array(reviewIssue).optional().describe("测试代码审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    assertAgent(context, "opx_task_review_submit", ["openspec-reviewer-task"])
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`task_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
    }
    if (!tg.phases.review.tool.completed) {
      throw new Error("tool 层审核未完成，task 层不可提交。")
    }
    if (tg.phases.review.task.completed && !allTasksVerified(tg.tasks)) {
      throw new Error("task 层审核报告已提交，不允许重复提交。")
    }

    // Task 验证：verified_task_ids + failed_task_ids
    const verified = args.verified_task_ids || []
    const failed = args.failed_task_ids || []
    const tasks = tg.tasks
    const validIds = new Set(tasks.map((t) => t.id))
    const unknownVerified = verified.filter((id) => !validIds.has(id))
    const unknownFailed = failed.filter((f) => !validIds.has(f.task_id))
    if (unknownVerified.length > 0 || unknownFailed.length > 0) {
      throw new Error(
        `非法 task id：${[...unknownVerified.map((id) => `"${id}"`), ...unknownFailed.map((f) => `"${f.task_id}"`)].join(", ")}。` +
        `合法 id：${Array.from(validIds).join(", ")}。`
      )
    }

    // 完整性门禁：每个 submitted task 必须被覆盖
    const submittedTasks = tasks.filter((t) => t.status === "submitted")
    const coveredIds = new Set([...verified, ...failed.map((f) => f.task_id)])
    const uncovered = submittedTasks.filter((t) => !coveredIds.has(t.id))
    if (uncovered.length > 0) {
      throw new Error(
        `以下 submitted task 未被 verified_task_ids 或 failed_task_ids 覆盖：` +
        uncovered.map((t) => `#${t.id} ${t.title}`).join("; ")
      )
    }

    for (const id of verified) {
      const task = tasks.find((t) => t.id === id)
      if (task && task.status === "submitted") { task.status = "verified" }
    }
    await updateTasksMdForVerifiedTasks(context.worktree, state.changeId, tg.tasks, verified)
    for (const f of failed) {
      const task = tasks.find((t) => t.id === f.task_id)
      if (task && task.status === "submitted") {
        task.status = "rejected"
        task.rejectReason = f.reason
      }
    }

    // 处理测试审查 issues
    const rawIssues = (args.issues || []) as any[]
    let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
    const taskNewIssues: IssueItem[] = []
    for (const iss of rawIssues) {
      const dedupResult = deduplicateAndAddIssues(
        [iss], tg.issues,
        "style" as Dimension, "task",
        nextIssueId
      )
      if (dedupResult.dedupedCount > 0) continue
      if (dedupResult.newIssues.length > 0) {
        tg.issues.push(dedupResult.newIssues[0])
        taskNewIssues.push(dedupResult.newIssues[0])
        nextIssueId = dedupResult.nextIssueId
      }
    }

    // 检查新报 issues（对齐 tool/quality 行为）
    assertPassWithIssues(args.passed, args.issues || [], "opx_task_review_submit")

    // 统一 issue 裁定门禁（gate 先执行，消解活跃 issue）
    applyReviewGate(tg.issues, args.fixed_issue_ids || [], args.exempt_issue_ids || [], args.rejected_issue_ids || [], undefined, "task")

    // 合并执行边界（自动基于 issue file 目录扩展 + reviewer 显式声明扩展）
    if (tg.executionBoundary) {
      if (taskNewIssues.length > 0) {
        const dirs = tg.executionBoundary.allowed_directories
        for (const iss of taskNewIssues) {
          const dir = path.dirname(iss.file)
          const entry = dir === "" || dir === "." ? iss.file : dir
          if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
        }
      }
      if (args.boundary_expansion) {
        if (args.passed) {
          throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
        }
        mergeExecutionBoundary(tg, args.boundary_expansion)
      }
    }

    // passed 一致性校验（gate 之后，状态已确定）
    if (args.passed) {
      if (failed.length > 0) {
        throw new Error(`任务层审核声称 passed=true，但存在 ${failed.length} 个未通过的 task。`)
      }
      if (hasBlockingIssues(tg.issues)) {
        throw new Error(`任务层审核声称 passed=true，但存在阻塞 issue。`)
      }
    }
    if (!args.passed && failed.length === 0) {
      throw new Error(
        `任务层审核声称 passed=false，但 failed_task_ids 为空。` +
        `passed=false 时必须至少指定一个 failed_task_id 标记不通过的 task。`
      )
    }

    tg.phases.review.task.completed = true
    await writeState(context.worktree, state)

    // 推进判定
    if (args.passed) {
      return JSON.stringify({
        status: "ok",
        phase: "review(task=completed)",
        message: "task 层审核通过。进入 quality review 层。请分派 5 维 reviewer。",
      })
    }

    tg.phases.review.retryCount++
    const retryCount = tg.phases.review.retryCount
    if (retryCount > 0 && retryCount % MAX_RETRIES === 0) {
      await writeState(context.worktree, state)
      return JSON.stringify({
        status: "needs_user_decision",
        layer: "task",
        retry_count: retryCount,
        message: `审查重试达到检查点（第 ${retryCount} 轮）。请编排者调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`,
      })
    }
    tg.phases.review.task.completed = false
    tg.status = "dev_impl"
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "rejected",
      phase: "review→dev_impl",
      retry_count: retryCount,
      layer: "task",
      message: `task 层审核不通过（第 ${retryCount} 轮）。请分派 openspec-developer 修复后重新提交。将从 tool 层重新开始审核。`,
    })
  },
})

// ═══════════════════════════════════════════════════════════
//  工具: opx_quality_review_submit
// ═══════════════════════════════════════════════════════════

export const quality_review_submit = tool({
  description:
    "AI 语义审查层提交。维度由调用者身份自动识别。调用者必须为 openspec-reviewer-{style|architecture|performance|security|maintainability}。",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    passed: tool.schema.boolean().describe("本维度是否通过"),
    issues: tool.schema.array(reviewIssue).optional().describe("新报审查 issue"),
    fixed_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("已修复的既有 issue ID 列表"),
    exempt_issue_ids: tool.schema.array(tool.schema.string()).optional().describe("豁免裁定的 issue ID 列表"),
    rejected_issue_ids: tool.schema.array(rejectedIssueItem).optional().describe("驳回的 issue 列表（含原因）"),
    boundary_expansion: boundaryExpansionSchema.optional().describe("执行边界扩展（仅 passed=false 时有效）"),
  },
  async execute(args, context) {
    const agentToDim = Object.fromEntries(
      Object.entries(DIMENSION_AGENT_MAP).map(([dim, agent]) => [agent, dim])
    )
    const dimension = agentToDim[context.agent] as Dimension | undefined
    if (!dimension) {
      throw new Error(
        `工具 "opx_quality_review_submit" 不支持调用者 "${context.agent}"。` +
        `仅支持：${Object.values(DIMENSION_AGENT_MAP).join(", ")}。`
      )
    }
    if (typeof args.passed !== "boolean" && args.passed !== "true" && args.passed !== "false") {
      throw new Error(
        `参数 passed 必须为布尔值（true/false），收到类型 "${typeof args.passed}"，值 "${args.passed}"。`
      )
    }
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`quality_review_submit 需在 review 阶段调用，当前阶段为 "${tg.status}"。`)
    }
    if (!tg.phases.review.task.completed) {
      throw new Error("task 层审核未完成，quality 层不可提交。")
    }
    if (tg.phases.review.quality.progress[dimension].submitted) {
      throw new Error(`维度 "${dimension}" 的审查报告已提交，不允许重复提交。`)
    }

    const passed = args.passed === true || (args.passed as any) === "true"
    const issues = (args.issues || []) as any[]
    assertPassWithIssues(passed, issues, "opx_quality_review_submit")

    // 每个 issue 必须有非空 suggestion
    for (const iss of issues) {
      if (!iss.suggestion || typeof iss.suggestion !== "string" || iss.suggestion.trim() === "") {
        throw new Error(`dimension="${dimension}" 的 issue 必须提供非空 suggestion。`)
      }
    }

    // 统一 issue 裁定门禁（本维度）
    applyReviewGate(tg.issues, args.fixed_issue_ids || [], args.exempt_issue_ids || [], args.rejected_issue_ids || [], dimension, "quality")

    // 去重并添加新 issue
    let nextIssueId = tg.issues.reduce((m, i) => Math.max(m, parseInt(i.id, 10) || 0), 0) + 1
    const newIssues: IssueItem[] = []
    let dedupedCount = 0
    for (const iss of issues) {
      const dedupResult = deduplicateAndAddIssues(
        [iss], tg.issues, dimension, "quality",
        nextIssueId
      )
      if (dedupResult.dedupedCount > 0) { dedupedCount++; continue }
      if (dedupResult.newIssues.length > 0) {
        newIssues.push(dedupResult.newIssues[0])
        nextIssueId = dedupResult.nextIssueId
      }
    }
    tg.issues.push(...newIssues)

    // 合并执行边界
    if (tg.executionBoundary && newIssues.length > 0) {
      const dirs = tg.executionBoundary.allowed_directories
      for (const iss of newIssues) {
        const dir = path.dirname(iss.file)
        const entry = dir === "" || dir === "." ? iss.file : dir
        if (entry !== "." && entry !== "" && !dirs.includes(entry)) dirs.push(entry)
      }
    }

    // 合并执行边界（reviewer 显式声明扩展，仅 passed=false）
    if (tg.executionBoundary && args.boundary_expansion) {
      if (args.passed) {
        throw new Error("passed=true 时不允许边界扩展。boundary_expansion 仅 passed=false 有效。")
      }
      mergeExecutionBoundary(tg, args.boundary_expansion)
    }

    tg.phases.review.quality.progress[dimension] = { submitted: true, passed }
    await writeState(context.worktree, state)
    const resultStr = await finalizeQualityPhase(state, tg, dimension, passed, context)
    if (dedupedCount > 0) {
      const result = JSON.parse(resultStr)
      result.deduped = dedupedCount
      result.message = result.message.replace(/([。！])\s*$/, `；${dedupedCount} 个重复 issue 已自动跳过。`)
      return JSON.stringify(result)
    }
    return resultStr
  },
})

// ─── quality 整体判定 ───

async function finalizeQualityPhase(
  state: OrchestrateState,
  tg: TaskGroupState,
  dimension: ReviewDimension,
  passed: boolean,
  context: { worktree: string },
): Promise<string> {
  const allDims = Object.keys(tg.phases.review.quality.progress) as ReviewDimension[]
  const submittedDims = dimsWithPendingAction(tg)
  const requiredDims: ReviewDimension[] =
    !tg.phases.review.quality.baselineDone
      ? allDims
      : allDims.filter((d) => tg.phases.review.quality.progress[d].submitted || submittedDims.has(d))
  const allSubmitted = requiredDims.every((d) => tg.phases.review.quality.progress[d].submitted)

  if (!allSubmitted) {
    const submittedCount = requiredDims.filter((d) => tg.phases.review.quality.progress[d].submitted).length
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

  // 全维已提交——标识基线建立
  tg.phases.review.quality.baselineDone = true

  const failedDims: ReviewDimension[] = []
  for (const d of requiredDims) {
    if (!tg.phases.review.quality.progress[d].passed) failedDims.push(d)
  }
  const hasResidualBlocking = tg.issues.some(
    (i) => (i.status === "open" || i.status === "rejected" || i.status === "exemption") && isBlockingIssue(i)
  )

  if (failedDims.length === 0 && !hasResidualBlocking) {
    tg.phases.review.completed = true
    tg.phases.review.quality.completed = true
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "ok",
      phase: "review=completed",
      message: "全部审查维度通过。请调用 opx_orch_complete_task_group 收尾（合并+清理）。",
    })
  }

  tg.phases.review.retryCount++
  const retryCount = tg.phases.review.retryCount
  const reason = failedDims.length > 0
    ? `${failedDims.join(", ")} 未通过`
    : "存在未解决的 Low+ open/rejected issue"

  if (retryCount > 0 && retryCount % MAX_RETRIES === 0) {
    await writeState(context.worktree, state)
    return JSON.stringify({
      status: "needs_user_decision",
      layer: "quality",
      retry_count: retryCount,
      message: `审查重试达到检查点（第 ${retryCount} 轮）。请编排者调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`,
    })
  }

  tg.phases.review.quality.progress = createEmptyQualityProgress()
  tg.phases.review.quality.completed = false
  tg.status = "dev_impl"
  await writeState(context.worktree, state)
  return JSON.stringify({
    status: "rejected",
    phase: "review→dev_impl",
    retry_count: retryCount,
    layer: "quality",
    failed_dimensions: failedDims,
    has_residual_blocking: hasResidualBlocking,
    message: `quality 层审查不通过（第 ${retryCount} 轮）：${reason}。请分派 openspec-developer 修复后重新提交。将从 tool 层重新开始审核。`,
  })
}

// ═══════════════════════════════════════════════════════════
//  工具: opx_orch_resolve_review
// ═══════════════════════════════════════════════════════════

export const resolve_review = tool({
  description:
    "编排者在 review 阶段重试超上限（needs_user_decision）后，据用户决策推进：\n" +
    "- decision=continue：重置审查进度，切换到 dev_impl 阶段，developer 重新提交后回到 tool→task→quality 全流程基线\n" +
    "- decision=giveup：将剩余 Low+ open/rejected 及待裁定 exemption 置 exempted，标记 review 完成",
  args: {
    task_group_id: tool.schema.string().min(1).describe("任务组 ID"),
    decision: tool.schema
      .enum(["continue", "giveup"])
      .describe("continue=继续修复；giveup=放弃"),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_resolve_review")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    if (state.taskGroupId !== args.task_group_id) {
      throw new Error(`任务组 ID 不匹配：编排目标为 "${state.taskGroupId}"，收到的是 "${args.task_group_id}"。`)
    }
    const tg = findTaskGroup(state, args.task_group_id)
    if (tg.status !== "review") {
      throw new Error(`opx_orch_resolve_review 仅在 review 阶段可用，当前阶段为 "${tg.status}"。`)
    }
    const maxLayerRetry = tg.phases.review.retryCount
    if (maxLayerRetry === 0 || maxLayerRetry % MAX_RETRIES !== 0) {
      throw new Error(
        `opx_orch_resolve_review 仅在审查重试达到检查点（retryCount 为 ${MAX_RETRIES} 的整数倍，needs_user_decision 状态）时调用；` +
          `当前 retryCount=${tg.phases.review.retryCount}。`
      )
    }

    if (args.decision === "continue") {
      tg.phases.review.lastResolvedRetryCount = tg.phases.review.retryCount
      tg.phases.review.tool.completed = false
      tg.phases.review.task.completed = false
      tg.phases.review.quality.completed = false
      tg.phases.review.quality.progress = createEmptyQualityProgress()
      tg.phases.review.quality.baselineDone = false
      tg.phases.review.completed = false
      tg.status = "dev_impl"
      await writeState(context.worktree, state)
      return JSON.stringify(
        {
          status: "ok",
          decision: "continue",
          phase: "review(in_progress)",
          message: "已重置各层审查进度，回到 tool 层基线。请分派 openspec-developer 修复后调用 opx_dev_submit。",
        },
        null,
        2
      )
    }

    // giveup
    let exemptedCount = 0
    for (const issue of tg.issues) {
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
        message: `已将剩余 ${exemptedCount} 个 Low+ open/rejected 及待裁定 issue 置为 exempted。请调用 opx_orch_complete_task_group 收尾。`,
      },
      null,
      2
    )
  },
})

// ─── dashboard 只读投影 ───

export async function readDashboardState(worktree: string) {
  const state = await readStateByWorktree(worktree)
  if (!state) return null

  return {
    active: true,
    changeId: state.changeId,
    currentTaskGroupId: state.taskGroupId,
    baseBranch: state.baseBranch,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    taskGroups: state.taskGroups.map((tg) => ({
      id: tg.id,
      name: tg.name,
      taskCount: tg.taskCount,
      status: tg.status,
      lifecycle: deriveStatus(tg, state.taskGroupId),
      worktreePath: tg.worktreePath,
      branchName: tg.branchName,
      relevantSpecs: tg.relevantSpecs,
      phases: tg.phases,
      tasks: tg.tasks,
      issues: tg.issues,
    })),
  }
}
