import { tool } from "@opencode-ai/plugin"
import path from "path"
import type { TaskGroupState, TaskItem, IssueItem, TaskStatus, Phase, BuildPhaseTarget, Phases, OrchestrateState } from "./types.js"
import { ORCHESTRATOR_AGENT, PHASE_ORDER, MAX_RETRIES, BLOCKING_SEVERITIES, DIMENSION_AGENT_MAP, AGENT_TO_SUBMIT_TOOL } from "./constants.js"
import { REVIEW_DIMENSIONS } from "./types.js"
import { runGit, runGitChecked, getCurrentBranch, getMergeBase, getDiffFileList, isWorktreeClean, mergeBranchToTarget, discoverDiskWorktrees } from "./git.js"
import { readStateByWorktree, readStateByChangeId, writeState } from "./state.js"
import { parseAllTaskGroupsFromMd, parseTasksMdForGroup, extractRelevantSpecsFromTasks } from "./tasks-md.js"
import { createEmptyPhases, assertOrchestrator, findTaskGroup, isReviewCompleted, deriveCurrentAgents } from "./derive.js"
import {
  renderOrchestratorView,
  renderArchitectView,
  renderDeveloperView,
  renderToolReviewView,
  renderTaskReviewView,
  renderQualityReviewView,
} from "./views.js"

export const init = tool({
  description:
    "初始化编排会话。传入变更 ID 和任务组 ID，工具自动解析 tasks.md 提取全部任务组并解析目标组子任务。可通过 recovery 参数恢复到指定阶段。无 recovery 重复初始化当前任务组时保留其阶段和进度；切换到其它任务组时初始化该组。",
  args: {
    change_id: tool.schema.string().min(1).describe("OpenSpec 变更 ID"),
    task_group_id: tool.schema.string().min(1).describe("要初始化的任务组 ID。无 recovery 重复调用当前组时保留进度；切换任务组时仅初始化目标组。"),
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

    const parsedTasks = await parseTasksMdForGroup(context.worktree, args.change_id, args.task_group_id)
    const relevantSpecs = extractRelevantSpecsFromTasks(parsedTasks)
    const newTasks: TaskItem[] = parsedTasks.map((p, i) => ({
      id: String(i + 1),
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
          } else if (p === "review") {
          } else {
            phases.architect_review = { completed: true }
          }
        }
      }
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
    const currentTaskGroupId = state?.taskGroupId
    if (state) {
      state.baseBranch = state.baseBranch || baseBranch
      const existingMap = new Map(state.taskGroups.map((g) => [g.id, g]))
      state.taskGroups = parsedGroups.map((p) => {
        const existing = existingMap.get(p.id)

        if (p.id !== args.task_group_id) {
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
            issues: [], blockers: [],
          }
        }

        if (existing && !args.recovery && currentTaskGroupId === p.id) {
          return { ...existing, name: p.name, taskCount: p.taskCount }
        }

        const recoveryPhase = existing?.blockers.some((blocker) => blocker.status !== "resolved")
          ? "task_analysis"
          : args.recovery?.phase
        const defaultPhase = recoveryPhase ?? "task_analysis"
        const phases = args.recovery
          ? buildPhases(recoveryPhase as BuildPhaseTarget, args.recovery?.review_layer).phases
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
          phases.review = JSON.parse(JSON.stringify(existing.phases.review))
        } else {
          tgTasks = newTasks.map((t) => ({
            ...t,
            status: taskInjectionStatus,
          }))
          tgIssues = existing?.issues ?? []
          if (existing && args.recovery) {
            phases.review = JSON.parse(JSON.stringify(existing.phases.review))
          }
        }

        if (args.recovery?.phase === "review" && args.recovery?.review_layer) {
          const rl = args.recovery.review_layer
          if (rl === "task" || rl === "quality") {
            phases.review.tool.completed = true
          }
          if (rl === "quality") {
            phases.review.task.completed = true
            if (!preserveProgress) {
              phases.review.retryCount = 0
            }
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
          blockers: existing?.blockers ?? [],
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
            issues: [], blockers: [],
          }
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

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
    return JSON.stringify(
      {
        status: "initialized",
        change_id: state.changeId,
        task_group_count: state.taskGroups.length,
        current_task_group: targetGroup,
        active_phase: ctg.status,
        task_count: newTasks.length,
        message: `编排会话已初始化。${recoveryMsg}`,
      },
      null,
      2
    )
  },
})

export const set_worktree = tool({
  description:
    "确保目标组的 git worktree 就绪。若已存在则复用，否则按规范自动创建（分支 task-group/{id}，路径 .worktree/task-group-{id}）。只补齐资源，不改变阶段。",
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
      try {
        const f = Bun.file(path.join(wtPath, ".git"))
        if (await f.exists()) {
          throw new Error(`路径 "${wtPath}" 已存在 .git 但不在 worktree list 中，请手动检查。`)
        }
      } catch (e: any) {
        if (e.message?.includes("已存在 .git")) throw e
      }

      const forkBranch = state.baseBranch
      await runGit(repoRoot, ["worktree", "add", "-b", branch, wtPath, forkBranch])

      const baseRef = await getMergeBase(wtPath, forkBranch)
      if (!baseRef) throw new Error(`worktree 创建成功但无法获取与 ${forkBranch} 的 merge-base：${wtPath}`)

      tg.worktreePath = wtPath
      tg.branchName = branch
      tg.baseRef = baseRef
    }

    await writeState(context.worktree, state)

    const msg = reused
      ? `复用已有 worktree：${existingPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
      : `已创建 worktree：${wtPath}（分支 ${branch}）。baseRef=${tg.baseRef?.slice(0, 7)}。`
    return JSON.stringify(
      {
        status: "ok",
        reused,
        worktree_path: tg.worktreePath,
        branch_name: branch,
        base_ref: tg.baseRef,
        message: msg,
      },
      null,
      2
    )
  },
})

export const resume_blocker = tool({
  description: "编排者记录用户对 blocker 的原话，交架构师复核。",
  args: {
    blocker_id: tool.schema.string().min(1),
    user_response: tool.schema.string().min(1),
  },
  async execute(args, context) {
    assertOrchestrator(context, "opx_orch_resume_blocker")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
    const blocker = tg.blockers.find((item) => item.id === args.blocker_id)
    if (!blocker) throw new Error(`blocker #${args.blocker_id} 不在任务组 ${tg.id} 中。`)
    if (blocker.status !== "awaiting_user") throw new Error(`blocker #${args.blocker_id} 当前不是 awaiting_user，不能恢复。`)
    blocker.userResponse = args.user_response
    blocker.status = "ready_for_architect"
    tg.status = "task_analysis"
    await writeState(context.worktree, state)
    return JSON.stringify({ status: "ok", blocker_id: blocker.id, blocker_status: blocker.status, message: "用户答复已记录。" })
  },
})

export const status = tool({
  description:
    "统一只读状态/上下文查询。按调用者角色路由：orchestrator→统计+worktree；architect→spec/blocker；developer→worktree/boundary/task/issue；reviewer-tool→tool 层控件 issue；reviewer-task→task 验证状态；quality reviewer→自维度存量 issue。",
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

    if (agent !== ORCHESTRATOR_AGENT) {
      const submitTool = AGENT_TO_SUBMIT_TOOL[agent] || "对应 submit 工具"
      const submitConvention = agent === "openspec-architect"
        ? "按结果提交 `outcome=ready` 或 `outcome=awaiting_user`。"
        : agent === "openspec-developer"
          ? "按结果提交 `outcome=completed` 或 `outcome=blocked`。"
          : "即使无 issue / 无待处理项，也必须提交 `passed=true`。"
      const instructionBlock = [
        "# ✅ 当前轮到你执行",
        "",
        `完成本职工作后**必须**调用 \`${submitTool}()\` 提交。`,
        submitConvention,
        "",
        "---",
        "",
      ].join("\n")
      view = instructionBlock + view
    }

    return view
  },
})

export const complete_task_group = tool({
  description:
    "完成任务组收尾：合并 task-group 分支到 baseBranch → 清理 worktree 与分支。合并冲突时中止并返回 blocked（保留 worktree/分支）。",
  args: {},
  async execute(_args, context) {
    assertOrchestrator(context, "opx_orch_complete_task_group")
    const state = await readStateByWorktree(context.worktree)
    if (!state) throw new Error("编排会话未初始化。请先调用 opx_orch_init。")
    const tg = findTaskGroup(state, state.taskGroupId)
    if (!isReviewCompleted(tg) || tg.status === "completed") {
      throw new Error(
        `阶段顺序错误：opx_orch_complete_task_group 需在 review 完成后调用，当前 isReviewCompleted=${isReviewCompleted(tg)}，tg.status=${tg.status}。`
      )
    }
    if (tg.worktreePath) {
      const clean = await isWorktreeClean(tg.worktreePath)
      if (!clean) throw new Error(`worktree "${tg.worktreePath}" 存在未 commit 内容，请先 commit 再完成任务组。`)
    }
    const openIssues = tg.issues.filter(
      (i) => (i.status === "open" || i.status === "rejected") && (BLOCKING_SEVERITIES as readonly string[]).includes(i.severity)
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
    const unresolvedBlockers = tg.blockers.filter((blocker) => blocker.status !== "resolved")
    if (unresolvedBlockers.length > 0) {
      throw new Error(`存在 ${unresolvedBlockers.length} 个未解决 blocker，无法完成任务组。`)
    }
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
    if (tg.worktreePath && tg.branchName) {
      try {
        await runGit(context.worktree, ["worktree", "remove", tg.worktreePath, "--force"])
        await runGit(context.worktree, ["branch", "-D", tg.branchName])
      } catch {
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
