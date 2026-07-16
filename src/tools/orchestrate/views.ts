import type { TaskGroupState, OrchestrateState, TaskItem, IssueItem, ReviewDimension, Dimension } from "./types.js"
import { REVIEW_DIMENSIONS } from "./types.js"
import { SEVERITY_LEVELS, DIMENSION_AGENT_MAP, MAX_RETRIES } from "./constants.js"
import { deriveStatus, isReviewCompleted, allTasksVerified, deriveCurrentAgents, isBlockingIssue, isStatusUnresolved } from "./derive.js"

export function taskSummary(tasks: TaskItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0 }
  for (const t of tasks) counts[t.status]++
  return counts
}

export function issueSummary(issues: IssueItem[]): Record<string, number> {
  const counts: Record<string, number> = { open: 0, submitted: 0, rejected: 0, verified: 0, exemption_requested: 0, exempted: 0 }
  for (const i of issues) counts[i.status]++
  return counts
}

export function renderTaskItem(t: TaskItem): string {
  const trace = t.specTrace ? ` [spec:${t.specTrace}]` : ""
  return `- Task id=${t.id} ｜ ${t.title}${trace}`
}

export function sortIssuesByCategory(issues: IssueItem[]): IssueItem[] {
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

export function renderIssueItem(i: IssueItem): string {
  const lines: string[] = []
  lines.push(`- Issue #${i.id} | ${i.severity} | ${i.dimension} | [${i.sourcePhase}]`)
  lines.push(`  - 文件：${i.file}${i.line > 0 ? `:${i.line}` : ""}`)
  lines.push(`  - 描述：${i.description}`)
  if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
  if (i.status === "exemption_requested" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  if (i.status === "rejected" && i.rejectReason) lines.push(`  - 驳回原因：${i.rejectReason}`)
  lines.push(`  - 修复未过次数：${i.refixCount}`)
  return lines.join("\n")
}

export function renderOrchestratorView(state: OrchestrateState, tg: TaskGroupState, diskWorktrees?: { branch: string; path: string }[]): string {
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
  const devStatus = (tg.status === "review" || tg.status === "completed") ? "✓" : (tg.status === "dev_impl" ? "●" : "✗")
  lines.push(`| dev_impl | ${devStatus} |`)
  const reviewParts: string[] = []
  if (tg.phases.review.tool.completed) reviewParts.push("tool✓")
  if (tg.phases.review.task.completed && !tg.phases.review.tool.completed && allTasksVerified(tg.tasks)) {
    reviewParts.push("task(跳过)")
  } else if (tg.phases.review.task.completed) {
    reviewParts.push("task✓")
  }
  const allQualityPassed = REVIEW_DIMENSIONS.every(d => tg.phases.review.quality.progress[d] === "passed")
  if (allQualityPassed) reviewParts.push("quality✓")
  if (!tg.phases.review.tool.completed) reviewParts.push("tool⏳")
  else if (!tg.phases.review.task.completed) reviewParts.push("task⏳")
  else if (!allQualityPassed) reviewParts.push("quality⏳")
  const reviewLayer = reviewParts.join(" → ")
  const reviewStatus = isReviewCompleted(tg) ? "✓" : (tg.status === "review" ? `● ${reviewLayer}` : "✗")
  lines.push(`| review | ${reviewStatus} |`)
  lines.push("")
  lines.push("## Blocker", "")
  if (tg.blockers.length === 0) {
    lines.push("- (无)")
  } else {
    for (const blocker of tg.blockers) {
      lines.push(`- Blocker #${blocker.id} | ${blocker.status} | ${blocker.category}`)
      lines.push(`  - 来源：${blocker.sourceRole}${blocker.taskId ? `；Task #${blocker.taskId}` : ""}`)
      lines.push(`  - 描述：${blocker.description}`)
      if (blocker.userResponse) lines.push(`  - 用户答复：${blocker.userResponse}`)
      if (blocker.architectConclusion) lines.push(`  - 架构结论：${blocker.architectConclusion}`)
    }
  }
  lines.push("")
  lines.push("## Task 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${ts.open} |`)
  lines.push(`| submitted | ${ts.submitted} |`)
  lines.push(`| rejected | ${ts.rejected} |`)
  lines.push(`| verified | ${ts.verified} |`)
  lines.push("")
  lines.push("## Issue 摘要", "")
  lines.push(`| 状态 | 数量 |`)
  lines.push(`|------|------|`)
  lines.push(`| open | ${is.open} |`)
  lines.push(`| submitted | ${is.submitted} |`)
  lines.push(`| rejected | ${is.rejected} |`)
  lines.push(`| verified | ${is.verified} |`)
  lines.push(`| exemption_requested | ${is.exemption_requested} |`)
  lines.push(`| exempted | ${is.exempted} |`)
  lines.push("")
  lines.push("## 审核进度", "")
  const rp = tg.phases.review.quality.progress
  const fmt = (k: ReviewDimension) => `${k}=${rp[k]}`
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
  lines.push("")
  lines.push("## 一致性分析", "")
  const checks: string[] = []
  if ((tg.status === "review" || tg.status === "completed") && tg.phases.architect_review.completed === false) {
    checks.push(`- ⚠️ 阶段逆序：status=${tg.status} 但 architect_review 未完成`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "task_analysis", ... } })\``)
  }
  if (isReviewCompleted(tg) && tg.status !== "review" && tg.status !== "completed") {
    checks.push(`- ⚠️ 阶段逆序：status=${tg.status} 但 review 已完成`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "review", ... } })\``)
  }
  if ((tg.status === "dev_impl" || tg.status === "review") && !tg.executionBoundary) {
    checks.push(`- ⚠️ 缺 executionBoundary：status=${tg.status} 但 executionBoundary=null`)
    checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "task_analysis", ... } })\``)
  }
  for (const dim of REVIEW_DIMENSIONS) {
    if (tg.phases.review.quality.progress[dim] === "passed") {
      const openInDim = tg.issues.filter(
        (i) => i.dimension === dim && i.sourcePhase === "quality" && isStatusUnresolved(i.status) && isBlockingIssue(i)
      )
      if (openInDim.length > 0) {
        checks.push(`- ⚠️ review 内部矛盾：维度 ${dim} passed 但仍有 ${openInDim.length} 个阻塞 issue`)
        checks.push(`  建议：\`opx_orch_init({ recovery: { phase: "${tg.status === "completed" ? "review" : tg.status}", ... } })\``)
      }
    }
  }
  if (tg.status === "review") {
    const atCheckpoint = tg.phases.review.retryCount > 0 && tg.phases.review.retryCount % MAX_RETRIES === 0
    const alreadyResolved = tg.phases.review.retryCount === tg.phases.review.lastResolvedRetryCount
    if (atCheckpoint && !alreadyResolved) {
      checks.push(`- ⛔ 审查重试达到检查点（第 ${tg.phases.review.retryCount} 轮），需要用户决策。`)
      checks.push(`  唯一动作：调用 \`opx_orch_resolve_review\` 推进（continue / giveup）。`)
    }
  }
  if (checks.length > 0) {
    lines.push(...checks)
    lines.push("")
    lines.push("请用 question 向用户展示上述异常，确认后按对应建议调用 opx_orch_init(recovery=...) 修复。")
  } else {
    lines.push("未发现状态异常。")
  }
  lines.push("", "## 下一步", "")
  if (checks.length > 0) {
    lines.push("以上状态异常，请按 recovery 建议修复。")
  } else if (tg.status === "completed") {
    lines.push("编排已完成。")
  } else if (isReviewCompleted(tg)) {
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
        if (agents.length > 1) {
          lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
        }
        if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
          lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
        }
      } else {
        lines.push("（无待分派项，请检查状态）")
      }
    }
  } else if (tg.blockers.some((blocker) => blocker.status === "awaiting_user")) {
    lines.push("等待用户答复 blocker。")
  } else if (tg.status === "dev_impl" && (!tg.worktreePath || !tg.baseRef)) {
    lines.push("资源未就绪：调用 `opx_orch_set_worktree`。")
  } else {
    const agents = deriveCurrentAgents(tg)
    if (agents.length > 0) {
      const agentList = agents.map((a) => `\`${a}\``).join("、")
      lines.push(`分派子代理：${agentList}。`)
      if (agents.length > 1) {
        lines.push("（多子代理相互独立，可在单条消息中并排分派，无需串行等待）")
      }
      if (tg.phases.review.task.completed && !tg.phases.review.tool.completed) {
        lines.push("（说明：task 层已自动跳过，tool review 完成后直接进入 quality review）")
      }
    } else {
      lines.push("（无待分派项，请检查状态）")
    }
  }
  return lines.join("\n")
}

export function renderArchitectView(state: OrchestrateState, tg: TaskGroupState): string {
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
lines.push(`- \`openspec/changes/${state.changeId}/\``)
    }
  }
  lines.push("")
  lines.push("## Blocker (待架构复核)", "")
  const unresolvedBlockers = tg.blockers.filter((blocker) => blocker.status !== "resolved")
  if (unresolvedBlockers.length === 0) {
    lines.push("- (无)")
  } else {
    for (const blocker of unresolvedBlockers) {
      lines.push(`- Blocker #${blocker.id} | ${blocker.status} | ${blocker.category}`)
      lines.push(`  - 来源：${blocker.sourceRole}${blocker.taskId ? `；Task #${blocker.taskId}` : ""}`)
      lines.push(`  - 描述：${blocker.description}`)
      lines.push(`  - 证据：${blocker.evidence}`)
      lines.push(`  - 已尝试：${blocker.attemptedActions}`)
      if (blocker.options.length > 0) lines.push(`  - 可选方案：${blocker.options.join("；")}`)
      if (blocker.userResponse) lines.push(`  - 用户答复：${blocker.userResponse}`)
      if (blocker.architectConclusion) lines.push(`  - 架构结论：${blocker.architectConclusion}`)
    }
  }
  lines.push("")
  
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("1. 读取以下文档原文：clarify.md（架构方向结论）、tasks.md（全部任务组标题 + 当前组全文）、design.md（当前组相关章节）、上方「相关 spec 文件」所有文件")
  lines.push("2. 交叉比对：")
  lines.push("   - spec ↔ tasks：当前组子任务是否有对应需求？")
  lines.push("   - spec ↔ design：设计方案是否覆盖 spec 需求？")
  lines.push("   - tasks ↔ design：每项 task 是否有技术方案支撑？完成标准是否一致？")
  lines.push("3. 检查：")
  lines.push("   - 前置依赖是否就绪？")
  lines.push("   - 实施所需信息是否齐备？（模板路径/字段映射/外部依赖决策等）")
  lines.push("   - 接口/模型是否与 design 冲突？")
  lines.push("   - 任务排列是否合理？（基础架构类任务应在更早完成）")
  lines.push("4. 可本地修复的问题（仅限 md 文件）→ edit；信息缺口 → opx_arch_submit(outcome=\"awaiting_user\")")
  lines.push("5. 识别本 change 涉及应标准化的共性能力：优先判断能否通过确定性规则自动拦截（按已加载技术栈 skill 的工具化指引）；不能工具化的，edit `.agents/skills/` 固化为项目执行标准 skill")
  lines.push("6. 复核上方「Blocker (待架构复核)」中 ready_for_architect 项（结合用户答复裁定）；opx_arch_submit(outcome=ready) 自动结案 reported/ready_for_architect blocker")
  lines.push("7. 将本 change 必须加载的 skill 路径填入 execution_boundary.skills")
  lines.push("8. 确定 execution_boundary（含测试代码目录）→ opx_arch_submit(outcome=\"ready\")")
  return lines.join("\n")
}

export function renderDeveloperView(state: OrchestrateState, tg: TaskGroupState): string {
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
    if (b.skills && b.skills.length > 0) {
      lines.push("- **需加载 skill**:")
      for (const sk of b.skills) lines.push(`  - \`${sk}\``)
      lines.push("")
      lines.push("加载 executionBoundary.skills 中的 skill：优先 skill tool 加载（若已注册），未注册则 read 路径读取；再按 available_skills 的 description 自匹配兜底")
    }
  } else {
    lines.push("- (无)")
  }
  lines.push("")
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
  const rejectedTasks = tg.tasks.filter((t) => t.status === "rejected")
  if (rejectedTasks.length === 0) lines.push("- (无)")
  else for (const t of rejectedTasks) {
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
  const exemptionIssues = tg.issues.filter((i) => i.status === "exemption_requested")
  if (exemptionIssues.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(exemptionIssues)) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("1. 按「Task (待完成)」逐项实施（仅限上方「执行边界」内）")
  lines.push("2. 按 issue 中 suggestion 修复「Issue (待修复 · Low 及以上，必办)」；Info 可选")
  lines.push("3. 不可修 issue → opx_dev_submit(request_exempts=[...])")
  lines.push("4. 全部完成 → commit → opx_dev_submit(outcome=\"completed\")")
  lines.push("5. 遇外部依赖/凭证/真实输入缺失无法继续 → opx_dev_submit(outcome=\"blocked\")")
  return lines.join("\n")
}

export function renderToolReviewView(state: OrchestrateState, tg: TaskGroupState): string {
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
    (i) => i.sourcePhase === "tool" && (i.status === "open" || i.status === "submitted" || i.status === "exemption_requested")
  )
  if (allIssues.length === 0) lines.push("- (无)")
  else for (const i of sortIssuesByCategory(allIssues)) {
    const dimTag = `[${i.dimension}]`
    lines.push(`- ${dimTag} Issue #${i.id} | ${i.severity} | ${i.file}${i.line > 0 ? `:${i.line}` : ""}`)
    lines.push(`  - 描述：${i.description}`)
    if (i.suggestion) lines.push(`  - 建议：${i.suggestion}`)
    if (i.status === "exemption_requested" && i.exemptReason) lines.push(`  - 豁免理由：${i.exemptReason}`)
  }
  lines.push("")
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("1. 加载质量门 skill，获取工具清单、执行命令与 issue 映射表")
  lines.push("2. 按质量门 skill 定义顺序逐项执行工具检查（环境检查 → 编译 → 格式 → 架构约束 → 静态分析 → 测试编译与覆盖率 → 深度扫描 → 工具配置检查）")
  lines.push("3. 每项检查先按质量门 skill 自愈步骤恢复，不可自愈用 question 提请用户裁定")
  lines.push("4. 按质量门 skill 映射表将工具输出翻译为统一 issue")
  lines.push("5. 汇总 → opx_tool_review_submit")
  return lines.join("\n")
}

export function renderTaskReviewView(state: OrchestrateState, tg: TaskGroupState): string {
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
    (i) => i.sourcePhase === "task" && (i.status === "open" || i.status === "submitted" || i.status === "exemption_requested")
  )
  if (taskIssues.length > 0) {
    lines.push("## 审查 Issue", "")
    for (const i of taskIssues) lines.push(renderIssueItem(i))
    lines.push("")
  }
  lines.push("")
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("1. Task 产出验证：逐条核验「Task (待验证)」中每个 task 的产出（文件是否存在、目录是否非空、配置项/依赖是否就绪），按技术栈 skill 中构建命令验证编译")
  lines.push("2. 服务启动验证：启动基础设施 → 启动应用 → 健康检查轮询（60s）→ 识别新增/变更接口 → curl 场景化测试（正常+边界）→ 记录结果 → 停止服务")
  lines.push("3. 测试代码审查：断言放水、边界缺失、Mock 过度、覆盖不足")
  lines.push("4. 缺少验证所需真实资源/输入/凭证 → opx_task_review_submit(passed=false)，不得以 stub/降级/跳过判定通过")
  lines.push("5. 汇总 → opx_task_review_submit")
  return lines.join("\n")
}

export function renderQualityReviewView(state: OrchestrateState, tg: TaskGroupState, agent: string): string {
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
    (i) => i.sourcePhase === "quality" && i.dimension === dimension && i.status === "exemption_requested"
  )
  lines.push("## 本维度 Issue (豁免裁定中)", "")
  if (exemptionIssues.length === 0) lines.push("- (无)")
  else for (const i of exemptionIssues) lines.push(renderIssueItem(i))
  lines.push("")
  lines.push("## 操作指引", "")
  lines.push("")
  lines.push("1. 逐文件审查「上轮变更文件」，按本维度审查标准发现问题")
  lines.push("2. 识别 dev 重复实现应抽取为标准的能力：优先判断能否通过确定性规则自动拦截；不能工具化的，edit `.agents/skills/` 固化为项目执行标准 skill，路径入 executionBoundary.skills 参数")
  lines.push("3. 核验「本维度 Issue (待确认)」中每条是否真已修复 → fixed_issue_ids（未达标的不列入）")
  lines.push("4. 裁定「本维度 Issue (豁免裁定中)」→ exempt_issue_ids / rejected_issue_ids")
  lines.push("5. 新发现的本维度问题 → 报 issue（severity 不可下调来使维度 passed）")
  lines.push("6. 产出 skill 路径传 quality_review_submit 的 skills 参数")
  lines.push("7. 完成 → opx_quality_review_submit")
  return lines.join("\n")
}
