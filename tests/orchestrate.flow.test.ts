/**
 * 编排流程测试：完整端到端场景
 *
 * 每个场景独立运行，无共享状态。全部走 fake-git（零 git 依赖）。
 * 每步从磁盘读回 state.json 断言，验证状态机在实际编排流程中的正确迁移。
 *
 * 运行：cd .opencode && bun test
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  set_worktree,
  arch_submit,
  dev_submit,
  reviewer_submit,
  complete_task_group,
  __setGitRunner,
} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-flow"

afterAll(() => { __setGitRunner(null) })

type Ctx = ReturnType<typeof makeCtx>
type Fake = FakeGitRunner

// ─── 辅助：搭建一个完整到 review 阶段的环境 ───

async function setupThroughReview(
  wt: string,
  fakeGit: FakeGitRunner,
  ctx: {
    orch: Ctx; arch: Ctx; dev: Ctx; val: Ctx
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
  await reviewer_submit.execute({
    task_group_id: "1", 
    verified_task_ids: ["1", "2"], failed_task_ids: [],
  }, ctx.val)
}

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

// ═══════════════════════════════════════════════════
//  Scenario 1: 完整 Happy Path
// ═══════════════════════════════════════════════════

describe("1. Happy Path — 完整流程", () => {
  test("init → arch_submit → set_worktree → dev_submit → task pass → 6 dims pass → complete", async () => {
    const root = `/tmp/ft1-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    // 1. init
    const r0 = JSON.parse(await init.execute({ change_id: CID, current_task_group_id: "1" }, o))
    expect(r0.status).toBe("initialized")
    expect(r0.active_phase).toBe("architect_review")
    expect(r0.current_task_group.id).toBe("1")
    expect(r0.task_group_count).toBe(2)

    let state = readStateSync(wt, CID)
    expect(state.currentTaskGroupId).toBe("1")
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("architect_review")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.phases.developer_implement.tasks).toHaveLength(2)

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
    expect(tg2.status).toBe("developer_implement")
    expect(tg2.worktreePath).not.toBeNull()
    expect(tg2.baseRef).toBe(fakeGit.baseRef)

    // 4. dev_submit
    const devWt = tg2.worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    const r3 = JSON.parse(await dev_submit.execute({ task_group_id: "1" }, d))
    expect(r3.status).toBe("ok")

    state = readStateSync(wt, CID)
    const tg3 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg3.phases.developer_implement.tasks.every((t: any) => t.status === "submitted")).toBe(true)
    expect(tg3.lastFilesChanged).toContain("src/F1.java")

    // 5. task verification (all pass)
    const r4 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", 
      verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v))
    expect(r4.status).toBe("ok")
    expect(r4.phase).toBe("developer_implement=completed, review=in_progress")

    state = readStateSync(wt, CID)
    const tg4 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg4.phases.developer_implement.completed).toBe(true)
    expect(tg4.status).toBe("review")

    // 6. 6 dimension reviewers all pass (首轮)
    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    for (let i = 0; i < dims.length; i++) {
      const agent = `openspec-reviewer-${dims[i]}`
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (dims[i] === "test") args.test_results = "all ok"
      const result = JSON.parse(await reviewer_submit.execute(args, makeCtx(agent, wt)))
      if (i < dims.length - 1) expect(result.status).toBe("partial")
      else {
        expect(result.status).toBe("ok")
        expect(result.phase).toBe("review=completed")
      }
    }

    state = readStateSync(wt, CID)
    const tg5 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg5.phases.review.completed).toBe(true)

    // 7. complete_task_group
    const r5 = JSON.parse(await complete_task_group.execute({ merge_target: "main" }, o))
    expect(r5.status).toBe("ok")
    expect(r5.completed_task_group).toBe("1")
    expect(r5.next_task_group).toBe("2")

    state = readStateSync(wt, CID)
    const tg6 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg6.status).toBe("completed")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 2: Validator 2 次驳回 → 修复 → 全部通过
// ═══════════════════════════════════════════════════

describe("2. Validator 两次驳回 → dev 两次修复 → 全部通过", () => {
  test("dev_submit → validator rejects task1 → dev retries → rejects again → dev retries → pass → reviewers → complete", async () => {
    const root = `/tmp/ft2-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Round 1: dev submits
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Round 1: validator rejects task 1
    const r1 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", 
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Implementation incomplete" }],
    }, v))
    expect(r1.status).toBe("partial")

    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.developer_implement.tasks.find((t: any) => t.id === "1").status).toBe("rejected")
    expect(tg1.status).toBe("developer_implement") // still in dev phase

    // Round 2: dev resubmits
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Round 2: validator rejects task 1 AGAIN
    const r2 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", 
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Still incomplete - missing error handling" }],
    }, v))
    expect(r2.status).toBe("partial")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.developer_implement.tasks.find((t: any) => t.id === "1").status).toBe("rejected")
    expect(tg2.phases.developer_implement.tasks.find((t: any) => t.id === "2").status).toBe("verified")

    // Round 3: dev resubmits again
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java", "src/F3.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Round 3: validator finally accepts all
    const r3 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", 
      verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v))
    expect(r3.status).toBe("ok")
    expect(r3.phase).toBe("developer_implement=completed, review=in_progress")

    state = readStateSync(wt, CID)
    const tg3 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg3.phases.developer_implement.completed).toBe(true)
    expect(tg3.status).toBe("review")

    // Now continue with review and complete
    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (dims[i] === "test") args.test_results = "all ok"
      const res = JSON.parse(await reviewer_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      if (i === dims.length - 1) expect(res.status).toBe("ok")
    }

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
  test("init → arch_submit(passed=false) → fix → arch_submit(passed=true) → set_worktree → dev → task → 6 dims → complete", async () => {
    const root = `/tmp/ft3-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    // init
    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)

    // Architect rejects first review (passed=false, no execution_boundary needed)
    const r1 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: false,
      issues: [{ file: "design.md", line: 5, type: "缺失", severity: "Medium", description: "Missing error handling section", suggestion: "Add error handling" }],
    }, a))
    expect(r1.status).toBe("blocked")
    expect(r1.phase).toBe("architect_review")

    let state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.architect_review.completed).toBe(false)

    // Architect re-submits with passed=true after "fixes"
    const r2 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r2.status).toBe("ok")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.architect_review.completed).toBe(true)

    // Now complete the rest of the flow
    await set_worktree.execute({}, o)
    state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({
      task_group_id: "1", verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v)

    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (dims[i] === "test") args.test_results = "ok"
      const res = JSON.parse(await reviewer_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
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
//  Scenario 4: 豁免裁定 — 验证 issue 状态流转
// ═══════════════════════════════════════════════════

describe("4. 豁免裁定 — reviewer 通过 exempt_issue_ids 授权", () => {
  test("setup → style fails(6 dims→retry) → dev requests exemption → style reviewer grants → issue=exempted", async () => {
    const root = `/tmp/ft4-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupThroughReview(wt, fakeGit, { orch: o, arch: a, dev: d, val: v })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Submit all 6 dims: style fails, others pass → triggers retry
    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    let lastResult: any
    for (let i = 0; i < dims.length; i++) {
      const args: any = {
        task_group_id: "1", passed: true, issues: [],
        fixed_issue_ids: [],
      }
      if (dims[i] === "style") {
        args.passed = false
        args.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }]
      }
      if (dims[i] === "test") args.test_results = "all ok"
      const res = JSON.parse(await reviewer_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      lastResult = res
    }
    expect(lastResult.status).toBe("rejected") // retry triggered
    expect(lastResult.retry_count).toBe(1)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].id

    // Dev requests exemption
    fakeGit.diffs.set(devWt, [])
    const r1 = JSON.parse(await dev_submit.execute({
      task_group_id: "1", request_exempts: [{ issue_id: issueId, reason: "Third-party lib constraint" }],
    }, d))
    expect(r1.status).toBe("ok")
    expect(r1.required_dimensions).toContain("style")

    state = readStateSync(wt, CID)
    const tg1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg1.phases.review.issues.find((i: any) => i.id === issueId).status).toBe("exemption")
    expect(tg1.phases.review.issues.find((i: any) => i.id === issueId).exemptReason).toBe("Third-party lib constraint")
    expect(tg1.phases.review.retryCount).toBe(1)

    // Style reviewer grants exemption via exempt_issue_ids
    const r2 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      exempt_issue_ids: [issueId],
      fixed_issue_ids: [],
    }, sCtx))
    expect(r2.status).toBe("ok")
    expect(r2.phase).toBe("review=completed")

    state = readStateSync(wt, CID)
    const tg2 = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 5: Recovery — developer_implement 阶段
// ═══════════════════════════════════════════════════

describe("5. Recovery — developer_implement 阶段恢复", () => {
  test("init → arch_submit → set_worktree → dev_submit → re-init recovery → 验证状态保留", async () => {
    const root = `/tmp/ft5-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt)

    // 先跑一段流程
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
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.tasks.every((t: any) => t.status === "submitted")).toBe(true)

    // Recovery: 恢复到 developer_implement（未完成验证，resubmit）
    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "developer_implement", worktree_path: devWt, branch_name: "task-group/1", preserve_progress: false },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("developer_implement")

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.phases.architect_review.completed).toBe(true)  // pre-target preserved
    expect(tg.phases.developer_implement.completed).toBe(false)
    // Tasks restored to "open" for re-attempt (since recovery phase <= developer_implement)
    expect(tg.phases.developer_implement.tasks.every((t: any) => t.status === "open")).toBe(true)
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
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupThroughReview(wt, fakeGit, { orch: o, arch: a, dev: d, val: v })

    // Create an issue
    await reviewer_submit.execute({
      task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }],
    }, sCtx)

    let state = readStateSync(wt, CID)
    const origIssueId = state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].id
    const origIssueDesc = state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].description

    // Recovery: 恢复到 review，保留 issues
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: devWt, branch_name: "task-group/1", preserve_progress: true },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("review")

    state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    // Pre-target phases preserved
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.phases.developer_implement.completed).toBe(true)
    // Review phase - issues should be preserved
    expect(tg.phases.review.issues).toHaveLength(1)
    expect(tg.phases.review.issues[0].id).toBe(origIssueId)
    expect(tg.phases.review.issues[0].status).toBe("open")  // preserved
    expect(tg.phases.review.issues[0].description).toBe(origIssueDesc)
    // Tasks should be verified (recovery phase = review → injection status = verified)
    expect(tg.phases.developer_implement.tasks.every((t: any) => t.status === "verified")).toBe(true)

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
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    // ── Group 1: 完整跑完 ──
    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    let state = readStateSync(wt, CID)
    fakeGit.diffs.set(state.taskGroups.find((g: any) => g.id === "1").worktreePath, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({
      task_group_id: "1", verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v)

    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (dims[i] === "test") args.test_results = "ok"
      await reviewer_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    await complete_task_group.execute({ merge_target: "main" }, o)

    // ── 验证 group1 已完成 ──
    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").status).toBe("completed")
    expect(state.currentTaskGroupId).toBe("2")  // advanced to next

    // ── 初始化 group2 ──
    const r2 = JSON.parse(await init.execute({ change_id: CID, current_task_group_id: "2" }, o))
    expect(r2.status).toBe("initialized")
    expect(r2.current_task_group.id).toBe("2")

    state = readStateSync(wt, CID)
    const g1 = state.taskGroups.find((g: any) => g.id === "1")
    expect(g1.status).toBe("completed")  // unchanged

    const g2 = state.taskGroups.find((g: any) => g.id === "2")
    expect(g2.status).toBe("architect_review")
    expect(g2.phases.architect_review.completed).toBe(false)
    expect(g2.phases.developer_implement.tasks).toHaveLength(1)  // only T3

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 8: Recovery — 从 architect_review 恢复
// ═══════════════════════════════════════════════════

describe("8. Recovery — architect_review 阶段（回退）", () => {
  test("init → arch_submit → re-init recovery to architect_review → 可重新提交 arch", async () => {
    const root = `/tmp/ft8-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)

    // Recovery to architect_review (before any work done)
    const r = JSON.parse(await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "architect_review", worktree_path: "", branch_name: "" },
    }, o))
    expect(r.status).toBe("initialized")
    expect(r.active_phase).toBe("architect_review")

    let state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    expect(tg.status).toBe("architect_review")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.phases.developer_implement.completed).toBe(false)
    expect(tg.phases.developer_implement.tasks.every((t: any) => t.status === "open")).toBe(true)

    // 仍可提交 arch_submit
    const r2 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r2.status).toBe("ok")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 9: Phase 2 豁免——validator 裁定
// ═══════════════════════════════════════════════════

describe("9. Phase 2 豁免 — validator 裁定", () => {
  test("validator 报 Phase 2 issue → dev 申请豁免 → validator grant → exempted", async () => {
    const root = `/tmp/ft9-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)

    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])

    // Dev submits tasks
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Validator reports Phase 2 issue + rejects task
    const r1 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1",
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Medium", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
    }, v))
    expect(r1.status).toBe("partial")

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].id
    expect(issueId).toBeDefined()
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].status).toBe("open")

    // Dev fixes task + requests exemption for issue
    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }],
    }, d)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].status).toBe("exemption")
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].exemptReason).toBe("Team convention")

    // Validator grants exemption + passes task
    const r2 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1",
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
      exempt_issue_ids: [issueId],
    }, v))
    // Phase should advance since all tasks done and issue exempted
    expect(r2.phase).toBe("developer_implement=completed, review=in_progress")

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("validator 报 Phase 2 issue → dev 申请豁免 → validator 不 grant → rejected", async () => {
    const root = `/tmp/ft9b-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

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
    await reviewer_submit.execute({
      task_group_id: "1",
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
      issues: [{ severity: "Medium", file: "src/F1.java", line: 5, description: "Exceeds 80 col", suggestion: "Wrap" }],
    }, v)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].id

    fakeGit.diffs.set(devWt, ["src/F1.java", "src/F2.java"])
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Team convention" }],
    }, d)

    // Validator does NOT include in exempt_issue_ids → implicitly rejected
    const r2 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1",
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, v))
    expect(r2.status).toBe("partial") // stuck because issue still unsettled

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].status).toBe("rejected")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 10: Phase 3 豁免通过 reviewer_submit（取代 arch_exempt_review）
// ═══════════════════════════════════════════════════

describe("10. Phase 3 豁免 — reviewer 裁定", () => {
  test("style fails(6 dims→retry) → dev requests exemption → style reviewer grants via exempt_issue_ids", async () => {
    const root = `/tmp/ft10-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupThroughReview(wt, fakeGit, { orch: o, arch: a, dev: d, val: v })
    let state = readStateSync(wt, CID)
    const devWt = state.taskGroups.find((g: any) => g.id === "1").worktreePath

    // Submit all 6 dims: style fails, others pass → triggers retry
    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    let lastResult: any
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }
      if (dims[i] === "style") {
        args.passed = false
        args.issues = [{ severity: "Low", file: "src/x.java", line: 1, description: "Style issue", suggestion: "Fix" }]
      }
      if (dims[i] === "test") args.test_results = "all ok"
      const res = JSON.parse(await reviewer_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt)))
      lastResult = res
    }
    expect(lastResult.status).toBe("rejected")
    expect(lastResult.retry_count).toBe(1)

    state = readStateSync(wt, CID)
    const issueId = state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].id

    // Dev requests exemption
    fakeGit.diffs.set(devWt, [])
    const r1 = JSON.parse(await dev_submit.execute({
      task_group_id: "1",
      request_exempts: [{ issue_id: issueId, reason: "Third-party lib constraint" }],
    }, d))
    expect(r1.status).toBe("ok")

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].status).toBe("exemption")

    // Style reviewer grants exemption (progress reset by retry)
    const r2 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1",
      passed: true,
      fixed_issue_ids: [],
      exempt_issue_ids: [issueId],
    }, sCtx))
    expect(r2.status).toBe("ok") // all dims pass

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ═══════════════════════════════════════════════════
//  Scenario 11: deriveDevStatus 阻塞 + finalizeOrPartial 处理 exemption
// ═══════════════════════════════════════════════════

describe("11. 守卫 — deriveDevStatus + finalizeOrPartial 处理", () => {
  test("blocking Phase 2 issue 阻止 validator 分派（deriveDevStatus）", async () => {
    const root = `/tmp/ft11-${Date.now()}`
    const wt = freshWt(root)
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

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

    // Validator passes all tasks but creates a blocking open issue
    await reviewer_submit.execute({
      task_group_id: "1",
      verified_task_ids: ["1", "2"], failed_task_ids: [],
      issues: [{ severity: "Medium", file: "src/F1.java", line: 5, description: "Issue", suggestion: "Fix" }],
    }, v)

    state = readStateSync(wt, CID)
    expect(state.taskGroups.find((g: any) => g.id === "1").phases.developer_implement.issues[0].status).toBe("open")

    // Blocking Phase 2 issue exists, deriveDevStatus should return "developing"
    // → reviewer_submit at line 1673-1675 should throw
    await expect(
      reviewer_submit.execute({
        task_group_id: "1",
        verified_task_ids: ["1", "2"], failed_task_ids: [],
      }, v)
    ).rejects.toThrow(/developing/)
  })
})
