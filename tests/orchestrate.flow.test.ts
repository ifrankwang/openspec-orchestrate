/**
 * 编排流程测试：完整端到端场景
 *
 * 每个场景独立运行，无共享状态。全部走 fake-git（零 git 依赖）。
 * 每步从磁盘读回 state.json 断言，验证状态机在实际编排流程中的正确迁移。
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  status,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  resolve_review,
  complete_task_group,
  __setGitRunner,
} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-flow"

afterAll(() => { __setGitRunner(null) })

type Ctx = ReturnType<typeof makeCtx>

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

function freshWt(root: string): string {
  const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const wt = join(root, id, "w")
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`,
    "utf-8"
  )
  return wt
}

async function setupThroughQualityReady(
  wt: string,
  fakeGit: FakeGitRunner,
  ctx: {
    orch: Ctx; arch: Ctx; dev: Ctx; toolReviewer: Ctx; taskReviewer: Ctx
  }
): Promise<void> {
  await init.execute({ change_id: CID, current_task_group_id: "1" }, ctx.orch)
  await arch_submit.execute({
    task_group_id: "1", passed: true, issues: [],
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
  }, ctx.arch)
  await set_worktree.execute({}, ctx.orch)
  const s1 = readStateSync(wt, CID)
  const devWt = s1.taskGroups.find((g: any) => g.id === "1").worktreePath
  fakeGit.diffs.set(devWt, ["src/F1.java"])
  await dev_submit.execute({ task_group_id: "1" }, ctx.dev)

  const s2 = readStateSync(wt, CID)
  const tg = s2.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, current_task_group_id: "1",
    recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
  }, ctx.orch)
  if (!tg.phases.review.tool.completed) {
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, ctx.toolReviewer)
  }
  if (!tg.phases.review.task.completed) {
    await task_review_submit.execute({
      task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, ctx.taskReviewer)
  }
}

/** 将当前状态推进到 review 阶段。传 exemptIds 可在 tool+task 层处理完整性门禁。 */
async function transitionToReview(
  wt: string, orch: Ctx, toolReviewer: Ctx, taskReviewer: Ctx,
  exemptIds?: string[]
): Promise<void> {
  const state = readStateSync(wt, CID)
  if (!state) return
  const tg = state.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, current_task_group_id: "1",
    recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
  }, orch)

  const s2 = readStateSync(wt, CID)
  const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
  if (!tg2.phases.review.tool.completed) {
    await tool_review_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      exempt_issue_ids: exemptIds || [],
      fixed_issue_ids: [],
    }, toolReviewer)
  }
  if (!tg2.phases.review.task.completed) {
    await task_review_submit.execute({
      task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, taskReviewer)
  }
}

// ═══════════════════════════════════════════════════
//  Scenario 1: 完整 Happy Path
// ═══════════════════════════════════════════════════

describe("1. Happy Path — 完整流程", () => {
  test("init → arch_submit → set_worktree → dev_submit → tool→task→5 dim quality → complete", async () => {
    const root = `/tmp/ft1-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // 1. init
    const r0 = JSON.parse(await init.execute({ change_id: CID, current_task_group_id: "1" }, o))
    expect(r0.status).toBe("initialized")
    expect(r0.active_phase).toBe("task_analysis")
    expect(r0.current_task_group.id).toBe("1")
    expect(r0.task_group_count).toBe(2)

    let state = readStateSync(wt, CID)
    expect(state.currentTaskGroupId).toBe("1")
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.tasks).toHaveLength(2)

    // 2. arch_submit passed
    const r1 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r1.status).toBe("ok")
    expect(r1.phase).toBe("architect_review=completed")

    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.architect_review.completed).toBe(true)
    expect(tg1.executionBoundary.allowed_directories).toContain("src")

    // 3. set_worktree
    const r2 = JSON.parse(await set_worktree.execute({}, o))
    expect(r2.status).toBe("ok")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.worktreePath).not.toBeNull()
    expect(tg2.baseRef).toBe(fakeGit.baseRef)

    // 4. dev_submit
    const devWt = tg2.worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    const r3 = JSON.parse(await dev_submit.execute({ task_group_id: "1" }, d))
    expect(r3.status).toBe("ok")

    state = readStateSync(wt, CID)
    const tg3 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg3.tasks.every((t: any) => t.status === "submitted")).toBe(true)
    expect(tg3.lastFilesChanged).toContain("src/F1.java")

    // 5. Transition to review + tool + task layer
    const s5 = readStateSync(wt, CID)
    const tg5 = s5.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg5.worktreePath, branch_name: tg5.branchName, preserve_progress: true },
    }, o)

    const rr1 = JSON.parse(await tool_review_submit.execute({
      task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [],
    }, toolR))
    expect(rr1.status).toBe("ok")
    expect(rr1.phase).toBe("review(tool=completed)")

    const rr2 = JSON.parse(await task_review_submit.execute({
      task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, taskR))
    expect(rr2.status).toBe("ok")
    expect(rr2.phase).toBe("review(task=completed)")

    state = readStateSync(wt, CID)
    const tg6 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg6.phases.dev_impl.completed).toBe(true)
    expect(tg6.status).toBe("review")

    // 6. 5 dimension quality reviewers all pass (首轮)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const agent = `openspec-reviewer-${dims[i]}`
      const result = JSON.parse(await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(agent, wt)))
      if (i < dims.length - 1) expect(result.status).toBe("partial")
      else {
        expect(result.status).toBe("ok")
        expect(result.phase).toBe("review=completed")
      }
    }

    state = readStateSync(wt, CID)
    const tg7 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg7.phases.review.completed).toBe(true)

    // 7. complete_task_group
    const r5 = JSON.parse(await complete_task_group.execute({ merge_target: "main" }, o))
    expect(r5.status).toBe("ok")
    expect(r5.completed_task_group).toBe("1")
    expect(r5.next_task_group).toBe("2")

    state = readStateSync(wt, CID)
    const tg8 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg8.status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 2: task reviewer 2 次驳回 → 修复 → 全部通过
// ═══════════════════════════════════════════════════

describe("2. 完整流程（无驳回）", () => {
  test("init → arch_submit → set_worktree → dev_submit → tool→task→5 dim → complete", async () => {
    const root = `/tmp/ft2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)

    let state = readStateSync(wt, CID)
    expect(state.currentTaskGroupId).toBe("1")
    let tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)

    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)

    state = readStateSync(wt, CID)
    tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.executionBoundary).toBeDefined()

    await set_worktree.execute({}, o)

    state = readStateSync(wt, CID)
    const tgWt = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgWt.status).toBe("dev_impl")
    expect(tgWt.worktreePath).not.toBeNull()
    const devWt = tgWt.worktreePath

    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    state = readStateSync(wt, CID)
    const tgDev = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgDev.tasks.every((t: any) => t.status === "submitted")).toBe(true)

    await transitionToReview(wt, o, toolR, taskR)

    state = readStateSync(wt, CID)
    const tgReview = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgReview.phases.review.tool.completed).toBe(true)
    expect(tgReview.phases.review.task.completed).toBe(true)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i === dims.length - 1) expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const tgQ = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgQ.phases.review.completed).toBe(true)

    await complete_task_group.execute({ merge_target: "main" }, o)
    state = readStateSync(wt, CID)
    const tgEnd = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgEnd.status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 3: 架构师复核驳回 → 修复 → 重新提交 → 完成全部流程
// ═══════════════════════════════════════════════════

describe("3. 架构师驳回 → 修复 → 重新提交 → 完成", () => {
  test("init → arch_submit(passed=false) → fix → arch_submit(passed=true) → set_worktree → dev → tool→task→5 dim → complete", async () => {
    const root = `/tmp/ft3-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)

    const r1 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: false,
      issues: [{ file: "design.md", line: 5, type: "缺失", severity: "Medium", description: "Missing error handling section", suggestion: "Add error handling" }],
    }, a))
    expect(r1.status).toBe("blocked")
    expect(r1.phase).toBe("architect_review")

    let state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.architect_review.completed).toBe(false)

    const r2 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r2.status).toBe("ok")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.architect_review.completed).toBe(true)

    await set_worktree.execute({}, o)
    state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    await transitionToReview(wt, o, toolR, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    await complete_task_group.execute({ merge_target: "main" }, o)
    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 4: 豁免裁定 — tool 层通过 exempt_issue_ids 授权
// ═══════════════════════════════════════════════════

describe("4. 豁免裁定 — tool 层通过 exempt_issue_ids 授权", () => {
  test("style quality 报 Info issue → dev 申请豁免 → tool 层 grant → exempted", async () => {
    const root = `/tmp/ft4-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Quality all pass with Info issue (non-blocking → passed=true still works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "src/x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      const res = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review: request exemption for Info issue
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }],
    }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption")

    // dev_submit reset layers. Re-run with exemption handling.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    // Quality re-run (5 dims all pass)
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else {
        expect(res.status).toBe("ok")
        expect(res.phase).toBe("review=completed")
      }
    }

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 5: Recovery — dev_impl 阶段
// ═══════════════════════════════════════════════════

describe("5. Recovery — dev_impl 阶段恢复", () => {
  test("init → arch_submit → set_worktree → dev_submit → re-init recovery → 验证状态保留", async () => {
    const root = `/tmp/ft5-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").tasks.every((t: any) => t.status === "submitted")).toBe(true)

    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "dev_impl", worktree_path: devWt, branch_name: "task-group/1", preserve_progress: false },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("dev_impl")

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.phases.dev_impl.completed).toBe(false)
    expect(tg.tasks.every((t: any) => t.status === "open")).toBe(true)
    expect(tg.worktreePath).toBe(devWt)
    expect(tg.branchName).toBe("task-group/1")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 6: Recovery — review 阶段（保留 issues）
// ═══════════════════════════════════════════════════

describe("6. Recovery — review 阶段恢复（保留 issues）", () => {
  test("setup through review → style fails → re-init recovery → 验证 issues 被保留", async () => {
    const root = `/tmp/ft6-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    // Create an issue via quality review
    await quality_review_submit.execute({
      task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }],
    }, sCtx)

    let state = readStateSync(wt, CID)
    const origIssueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id
    const origIssueDesc = state.taskGroups.find((g: any) => g.id === "1").issues[0].description

    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: devWt, branch_name: "task-group/1", preserve_progress: true },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("review")

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.phases.dev_impl.completed).toBe(true)
    expect(tg.issues).toHaveLength(1)
    expect(tg.issues[0].id).toBe(origIssueId)
    expect(tg.issues[0].status).toBe("open")
    expect(tg.issues[0].description).toBe(origIssueDesc)
    expect(tg.tasks.every((t: any) => t.status === "verified")).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 7: 多任务组 — 完成组1 → 初始化组2
// ═══════════════════════════════════════════════════

describe("7. 多任务组 — 完成 group1 → 初始化 group2", () => {
  test("init group1 → complete → init group2 → 验证 group2 独立", async () => {
    const root = `/tmp/ft7-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    await transitionToReview(wt, o, toolR, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    await complete_task_group.execute({ merge_target: "main" }, o)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")
    expect(state.currentTaskGroupId).toBe("2")

    const r2 = JSON.parse(await init.execute({ change_id: CID, current_task_group_id: "2" }, o))
    expect(r2.status).toBe("initialized")
    expect(r2.current_task_group.id).toBe("2")

    state = readStateSync(wt, CID)
    const g1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(g1.status).toBe("completed")

    const g2 = state.taskGroups.find((g: any) => g.id === "2")
    expect(g2.status).toBe("task_analysis")
    expect(g2.phases.architect_review.completed).toBe(false)
    expect(g2.tasks).toHaveLength(1)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 8: Recovery — task_analysis 阶段
// ═══════════════════════════════════════════════════

describe("8. Recovery — task_analysis 阶段（回退）", () => {
  test("init → arch_submit → re-init recovery to task_analysis → 可重新提交 arch", async () => {
    const root = `/tmp/ft8-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)

    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "task_analysis", worktree_path: "", branch_name: "" },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("task_analysis")

    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("task_analysis")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.phases.dev_impl.completed).toBe(false)
    expect(tg.tasks.every((t: any) => t.status === "open")).toBe(true)

    const r2 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r2.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 9: task 层豁免
// ═══════════════════════════════════════════════════

describe("9. 豁免裁定 — tool+task 层 via exempt_issue_ids", () => {
  test("task reviewer 报 issue → dev 申请豁免 → tool 层 grant → exempted", async () => {
    const root = `/tmp/ft9-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])

    await dev_submit.execute({ task_group_id: "1" }, d)

    // init recovery + tool pass + task reject + report issue
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({
      task_group_id: "1", passed: false,
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Info", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
      fixed_issue_ids: [],
    }, taskR)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id
    expect(issueId).toBeDefined()

    // Dev fixes + exemption via review phase dev_submit
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg2.worktreePath, branch_name: tg2.branchName, preserve_progress: true },
    }, o)
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }],
    }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption")
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).exemptReason).toBe("Team convention")

    // dev_submit reset layers. Re-run with exemption handled.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task reviewer 报 issue → dev 申请豁免 → tool 层 reject → rejected", async () => {
    const root = `/tmp/ft9b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])

    await dev_submit.execute({ task_group_id: "1" }, d)

    // init recovery + tool pass + task reject + issue
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({
      task_group_id: "1", passed: false,
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Info", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
      fixed_issue_ids: [],
    }, taskR)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // Dev fixes + exemption via review phase
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg2.worktreePath, branch_name: tg2.branchName, preserve_progress: true },
    }, o)
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }],
    }, d)

    // dev_submit reset layers. Re-run: tool rejects, then task passes.
    const s3 = readStateSync(wt, CID)
    const tg3 = s3.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg3.worktreePath, branch_name: tg3.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({
      task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [],
      rejected_issue_ids: [{issue_id: issueId, reason: "Testing rejection reason"}],
    }, toolR)
    await task_review_submit.execute({
      task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, taskR)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("rejected")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 10: quality 层豁免
// ═══════════════════════════════════════════════════

describe("10. quality 层豁免 — quality reviewer 裁定", () => {
  test("style reports Info issue → dev 申请豁免 → tool 层 pass through → exempted", async () => {
    const root = `/tmp/ft10-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Quality all pass with Info issue (non-blocking → passed=true still works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "src/x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      const res = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else expect(res.status).toBe("ok")
    }

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review with exemption
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }],
    }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exemption")

    // dev_submit reset layers. Re-run with exemption.
    await transitionToReview(wt, o, toolR, taskR, [issueId])

    // All quality re-run (issue exempted)
    for (let i = 0; i < dims.length; i++) {
      const res = JSON.parse(await quality_review_submit.execute({
        task_group_id: "1", passed: true, issues: [],
      }, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i < dims.length - 1) expect(res.status).toBe("partial")
      else {
        expect(res.status).toBe("ok")
        expect(res.phase).toBe("review=completed")
      }
    }

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 11: quality 层阻塞 issue 阻止完成
// ═══════════════════════════════════════════════════

describe("11. 守卫 — quality 阶段阻塞 issue", () => {
  test("quality review 中存在未解决阻塞 issue 时最后一维返回 rejected", async () => {
    const root = `/tmp/ft11-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    let lastResult: any
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }
      if (i === 0) {
        args.passed = false
        args.issues = [{ severity: "High", file: "src/x.java", line: 1, description: "Critical issue", suggestion: "Fix it" }]
      }
      const res = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      lastResult = res
    }
    expect(lastResult.status).toBe("rejected")
    expect(lastResult.failed_dimensions).toBeDefined()
    expect(lastResult.has_residual_blocking).toBe(true)

    const state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.phases.review.quality.retryCount).toBe(1)
    expect(tgAfter.status).toBe("dev_impl")
    const allNotSubmitted = Object.values(tgAfter.phases.review.quality.progress).every(
      (p: any) => p.submitted === false,
    )
    expect(allNotSubmitted).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 12: resolve_review — continue / giveup
// ═══════════════════════════════════════════════════

describe("12. resolve_review — continue / giveup", () => {
  test("continue — tool 3 轮失败 → needs_user_decision → resolve_review(continue) → 可重新从 tool 开始", async () => {
    const root = `/tmp/ft12-continue-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
         a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    try {
      // 1. init → arch → set_worktree → dev_submit
      await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
      await arch_submit.execute({
        task_group_id: "1", passed: true, issues: [],
        execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
      }, a)
      await set_worktree.execute({}, o)
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
      fakeGit.diffs.set(devWt, ["src/F1.java"])
      await dev_submit.execute({ task_group_id: "1" }, d)

      // 2. 4 轮 tool 失败：
      //    - 前 3 轮 rejected（→dev_submit 修复）
      //    - 第 4 轮 needs_user_decision
      // 每轮需通过 init(recovery to review)→dev_submit(review mode)
      // 重置 tool.completed 后才能再次提交 tool
      for (let round = 1; round <= 4; round++) {
        state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        await init.execute({
          change_id: CID, current_task_group_id: "1",
          recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
        }, o)

        if (round > 1) {
          fakeGit.diffs.set(devWt, [`src/FR${round - 1}.java`])
          await dev_submit.execute({ task_group_id: "1" }, d)
        }

        const r = JSON.parse(await tool_review_submit.execute({
          task_group_id: "1", passed: false, issues: [], fixed_issue_ids: [],
        }, toolR))

        if (round < 4) {
          expect(r.status).toBe("rejected")
          expect(r.retry_count).toBe(round)
        } else {
          expect(r.status).toBe("needs_user_decision")
          expect(r.retry_count).toBe(4)
        }
      }

      // 3. resolve_review(continue)
      const rc = JSON.parse(await resolve_review.execute({ task_group_id: "1", decision: "continue" }, o))
      expect(rc.status).toBe("ok")
      expect(rc.decision).toBe("continue")

      state = readStateSync(wt, CID)
      const tgS = state.taskGroups.find((g: any) => g.id === "1")
      expect(tgS.phases.review.tool.retryCount).toBe(0)
      expect(tgS.phases.review.tool.completed).toBe(false)
      expect(tgS.phases.review.task.completed).toBe(false)
      expect(tgS.phases.review.quality.completed).toBe(false)
      expect(tgS.phases.review.completed).toBe(false)

      // 4. 验证可重新从 tool 层开始
      fakeGit.diffs.set(devWt, ["src/F5.java"])
      await dev_submit.execute({ task_group_id: "1" }, d)

      const r5 = JSON.parse(await tool_review_submit.execute({
        task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [],
      }, toolR))
      expect(r5.status).toBe("ok")
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })

  test("giveup — quality 3 轮失败 → needs_user_decision → resolve_review(giveup) → blocking issue exempted + review completed", async () => {
    const root = `/tmp/ft12-giveup-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt),
         a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    try {
      // 1. 标准 setup 到 quality ready（tool + task pass）
      await setupThroughQualityReady(wt, fakeGit, { orch: o, arch: a, dev: d, toolReviewer: toolR, taskReviewer: taskR })
      let state = readStateSync(wt, CID)
      const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

      // 2. Round 1: 5 维 quality 全提交，style 报阻塞 issue → retryCount=1
      const dims = ["style", "architecture", "performance", "security", "maintainability"]
      let lastRes: any
      for (let i = 0; i < dims.length; i++) {
        const args: any = { task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }
        if (i === 0) {
          args.passed = false
          args.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Style blocking issue", suggestion: "Fix style" }]
        }
        lastRes = JSON.parse(await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      }
      expect(lastRes.status).toBe("rejected")
      expect(lastRes.retry_count).toBe(1)

      // Rounds 2-4：recovery → quality submit（仅 style 维度）。
      // 不再需要 dev_submit 重置——finalizeQualityPhase 已自动重置 quality.progress 和 quality.completed
      for (let round = 2; round <= 4; round++) {
        state = readStateSync(wt, CID)
        const tg = state.taskGroups.find((g: any) => g.id === "1")
        await init.execute({
          change_id: CID, current_task_group_id: "1",
          recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
        }, o)

        lastRes = JSON.parse(await quality_review_submit.execute({
          task_group_id: "1", passed: false,
          issues: [{ severity: "Low", file: "src/x.java", line: round, description: `Blocking issue round ${round}`, suggestion: "Fix" }],
          fixed_issue_ids: [],
        }, makeCtx("openspec-reviewer-style", wt)))

        if (round < 4) {
          expect(lastRes.status).toBe("rejected")
          expect(lastRes.retry_count).toBe(round)
        } else {
          expect(lastRes.status).toBe("needs_user_decision")
          expect(lastRes.retry_count).toBe(4)
          expect(lastRes.layer).toBe("quality")
        }
      }

      // 3. resolve_review(giveup)
      const rg = JSON.parse(await resolve_review.execute({ task_group_id: "1", decision: "giveup" }, o))
      expect(rg.status).toBe("ok")
      expect(rg.decision).toBe("giveup")
      expect(rg.exempted_count).toBeGreaterThan(0)

      state = readStateSync(wt, CID)
      const tgG = state.taskGroups.find((g: any) => g.id === "1")
      expect(tgG.phases.review.completed).toBe(true)
      for (const issue of tgG.issues) {
        expect(issue.status).toBe("exempted")
      }
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch {}
    }
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 13: 去阶段化 — dev 在 dev_impl 状态下可见 review issue
// ═══════════════════════════════════════════════════

describe("13. 去阶段化 — dev 在 dev_impl 状态下可见 review issue", () => {
  test("quality 报 issue → status=dev_impl → dev opx_status 可见 issue → 修复提交后自动回 review", async () => {
    const root = `/tmp/ft13-${Date.now()}`
    const wt = (() => {
      const dir = root
      const w = root + "/w"
      mkdirSync(join(w, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(w, "openspec", "changes", CID, "tasks.md"),
        "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n", "utf-8")
      return w
    })()
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // --- 1. Setup through quality ready (tool+task pass) ---
    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review (orchestrator does recovery)
    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    // --- 2. Quality review fails with issues (5 维全提交，仅 style 失败) ---
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.passed = false
        args.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Fix naming", suggestion: "Rename" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    // --- 3. After quality fail, status should be dev_impl ---
    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.status).toBe("dev_impl")

    // Issue should be in top-level issues[]
    expect(tgAfter.issues).toHaveLength(1)
    const issueId = tgAfter.issues[0].id
    expect(tgAfter.issues[0].status).toBe("open")

    // --- 4. Developer calls opx_status → should see the issue ---
    const devCtx = makeCtx("openspec-developer", wt)
    const viewText = await status.execute({}, devCtx)
    expect(viewText).toContain("Issue (待修复")
    expect(viewText).toContain("Fix naming")

    // --- 5. Developer fixes the issue ---
    fakeGit.diffs.set(devWt, ["src/F1.java"]) // simulates new commit
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
    }, d)

    // --- 6. After dev_submit with issues → status should be review (Option Y) ---
    state = readStateSync(wt, CID)
    const tgFinal = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFinal.status).toBe("review")
    expect(tgFinal.phases.review.tool.completed).toBe(false)
    expect(tgFinal.phases.review.task.completed).toBe(false)
    expect(tgFinal.phases.review.quality.completed).toBe(false)
    expect(tgFinal.issues.find((i: any) => i.id === issueId).status).toBe("submitted")

    // Cleanup
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 14: Task review auto-skip — issue-fix round
// ═══════════════════════════════════════════════════

describe("14. Task review auto-skip — issue-fix round", () => {
  test("quality 报 issue → 修复提交 → task 层自动跳过", async () => {
    const root = `/tmp/ft14-${Date.now()}`
    const wt = (() => {
      const w = root + "/w"
      mkdirSync(join(w, "openspec", "changes", CID), { recursive: true })
      writeFileSync(join(w, "openspec", "changes", CID, "tasks.md"),
        "## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n", "utf-8")
      return w
    })()
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    // --- 1. First full review cycle: tool+task passed, quality style fails ---
    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    const issueArgs: any = { task_group_id: "1", passed: true, issues: [] }
    issueArgs.passed = false
    issueArgs.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Fix naming", suggestion: "Rename" }]
    await quality_review_submit.execute(issueArgs, makeCtx("openspec-reviewer-style", wt))
    for (let i = 1; i < dims.length; i++) {
      await quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    // --- 2. After quality fail → dev_impl ---
    state = readStateSync(wt, CID)
    const tgAfter = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgAfter.status).toBe("dev_impl")
    expect(tgAfter.issues).toHaveLength(1)
    const issueId = tgAfter.issues[0].id

    // --- 3. Developer fixes the issue → status=review, no submitted tasks ---
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1", fixed_issue_ids: [issueId] }, d)

    state = readStateSync(wt, CID)
    const tgFix = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFix.status).toBe("review")
    expect(tgFix.phases.review.task.completed).toBe(false)
    expect(tgFix.phases.review.quality.retryCount).toBe(0)
    expect(tgFix.tasks.every((t: any) => t.status === "verified")).toBe(true)

    // --- 4. Tool review passes (with fixed issue) ---
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [issueId] }, toolR)

    // --- 5. Task review with no verified/failed tasks → auto-skip ---
    const result = JSON.parse(await task_review_submit.execute({
      task_group_id: "1", passed: true,
      // No verified_task_ids or failed_task_ids — all tasks already verified
    }, taskR))
    expect(result.status).toBe("ok")
    expect(result.phase).toBe("review(task=completed)")
    expect(result.message).toContain("自动跳过")

    // --- 6. State reflects auto-completed task layer ---
    state = readStateSync(wt, CID)
    const tgFinal = state.taskGroups.find((g: any) => g.id === "1")
    expect(tgFinal.phases.review.task.completed).toBe(true)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  try { rmSync(root, { recursive: true, force: true }) } catch {}
})
