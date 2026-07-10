import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  set_worktree,
  arch_submit,
  arch_exempt_review,
  dev_submit,
  reviewer_submit,
  complete_task_group,
  resolve_review,
  __setGitRunner,
} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx, readState } from "./helpers"

const CID = "test-change"

afterAll(() => { __setGitRunner(null) })

// Run full flow A as one test to avoid shared-state subtleties
describe("A. Happy Path (single sequential flow)", () => {
  const fakeGit = new FakeGitRunner()
  let wt: string
  type S = ReturnType<typeof readState>
  let state: S

  test("init → arch_submit → set_worktree → dev_submit → reviewer_task → 6 dims → complete", async () => {
    __setGitRunner(fakeGit)

    // Setup unique workspace
    const root = `/tmp/orch-test-${Date.now()}`
    wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2 [spec:s2]\n\n## 2. G2\n\n- [ ] 2.1 T3\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt)
    const a = makeCtx("openspec-architect", wt)
    const d = makeCtx("openspec-developer", wt)
    const v = makeCtx("openspec-validator", wt)

    // ── init ──
    const r0 = JSON.parse(await init.execute({ change_id: CID, current_task_group_id: "1" }, o))
    expect(r0.status).toBe("initialized")
    expect(r0.active_phase).toBe("architect_review")

    state = readState(wt, CID)
    expect(state).not.toBeNull()
    const tg = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg).toBeDefined()
    expect(tg.status).toBe("architect_review")
    expect(tg.phases.architect_review.completed).toBe(false)
    expect(tg.phases.developer_implement.tasks).toHaveLength(2)
    expect(tg.phases.developer_implement.tasks.every((t: any) => t.status === "open")).toBe(true)

    // ── arch_submit ──
    const r1 = JSON.parse(await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a))
    expect(r1.status).toBe("ok")
    expect(r1.phase).toContain("completed")

    state = readState(wt, CID)
    const tg2 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg2.phases.architect_review.completed).toBe(true)
    expect(tg2.executionBoundary.allowed_directories).toContain("src")

    // ── set_worktree ──
    const r2 = JSON.parse(await set_worktree.execute({}, o))
    expect(r2.status).toBe("ok")

    state = readState(wt, CID)
    const tg3 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg3.status).toBe("developer_implement")
    expect(tg3.worktreePath).not.toBeNull()
    expect(tg3.baseRef).toBe(fakeGit.baseRef)

    // ── dev_submit ──
    // Find what worktreePath set_worktree used
    let s1 = readState(wt, CID)
    const tgs1 = (s1!.taskGroups as any[]).find((g: any) => g.id === "1")
    const devWt = tgs1.worktreePath
    fakeGit.diffs.set(devWt, ["src/F1.java"])
    const r3 = JSON.parse(await dev_submit.execute({ task_group_id: "1" }, d))
    expect(r3.status).toBe("ok")
    expect(r3.active_phase).toBe("developer_implement")

    state = readState(wt, CID)
    const tg4 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg4.phases.developer_implement.tasks.every((t: any) => t.status === "submitted")).toBe(true)
    expect(tg4.lastFilesChanged).toContain("src/F1.java")

    // ── reviewer submit (task verification) ──
    const r4 = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", dimension: "task",
      verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v))
    expect(r4.status).toBe("ok")
    expect(r4.phase).toContain("review=in_progress")

    state = readState(wt, CID)
    const tg5 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg5.phases.developer_implement.completed).toBe(true)
    expect(tg5.status).toBe("review")

    // ── 6 dimension reviewers all pass ──
    const dims = ["style", "architecture", "performance", "security", "maintainability", "test"]
    for (let i = 0; i < dims.length; i++) {
      const agent = `openspec-reviewer-${dims[i]}`
      const args: any = { task_group_id: "1", dimension: dims[i], passed: true, issues: [] }
      if (dims[i] === "test") args.test_results = "all ok"
      const result = JSON.parse(await reviewer_submit.execute(args, makeCtx(agent, wt)))
      if (i < dims.length - 1) expect(result.status).toBe("partial")
      else {
        expect(result.status).toBe("ok")
        expect(result.phase).toBe("review=completed")
      }
    }

    state = readState(wt, CID)
    const tg6 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg6.phases.review.completed).toBe(true)

    // ── complete_task_group ──
    const r5 = JSON.parse(await complete_task_group.execute({ merge_target: "main" }, o))
    expect(r5.status).toBe("ok")
    expect(r5.completed_task_group).toBe("1")
    expect(r5.next_task_group).toBe("2")

    state = readState(wt, CID)
    const tg7 = (state!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg7.status).toBe("completed")

    // Verify git merge was called
    expect(fakeGit.mergedBranches).toContain("task-group/1")

    // Cleanup
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ─── B. Validator Reject → Dev Retry ───

describe("B. Validator reject → dev retry", () => {
  test("validator rejects task 1, status back to developing", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-b-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n- [ ] 1.2 T2\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt), d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({ task_group_id: "1", passed: true, issues: [], execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Reject task 1
    const r = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", dimension: "task",
      verified_task_ids: ["2"], failed_task_ids: [{ task_id: "1", reason: "Incomplete" }],
    }, v))
    expect(r.status).toBe("partial")

    let s = readState(wt, CID)
    const tg = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg.phases.developer_implement.tasks.find((t: any) => t.id === "1").status).toBe("rejected")
    expect(tg.phases.developer_implement.tasks.find((t: any) => t.id === "2").status).toBe("verified")

    // Dev resubmits
    fakeGit.diffs.set(wt, ["src/F2.java"])
    const r2 = JSON.parse(await dev_submit.execute({ task_group_id: "1" }, d))
    expect(r2.status).toBe("ok")

    s = readState(wt, CID)
    const tg2 = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg2.phases.developer_implement.tasks.find((t: any) => t.id === "1").status).toBe("submitted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ─── C. Reviewer reject → fix ───

describe("C. Reviewer reject → fix cycle", () => {
  test("reviewer rejects with issues → dev fixes → verify", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-c-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n- [ ] 1.2 T2\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt), d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    // Setup through review phase
    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({ task_group_id: "1", passed: true, issues: [], execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({ task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [] }, v)

    // Style reviewer fails with issue
    const sCtx = makeCtx("openspec-reviewer-style", wt)
    const r = JSON.parse(await reviewer_submit.execute({
      task_group_id: "1", dimension: "style", passed: false,
      issues: [{ severity: "Low", file: "src/x.java", line: 5, description: "Bad naming", suggestion: "Use camelCase" }],
    }, sCtx))
    // When retryCount=0 and other dims not submitted → "partial"
    expect(r.status).toBe("partial")

    let s = readState(wt, CID)
    const tg = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg.phases.review.issues).toHaveLength(1)
    expect(tg.phases.review.issues[0].status).toBe("open")
    expect(tg.phases.review.retryCount).toBe(0) // no retry yet, still waiting for other dims

    // Dev fixes the issue
    const issueId = tg.phases.review.issues[0].id
    fakeGit.diffs.set(wt, ["src/x.java"])
    const r2 = JSON.parse(await dev_submit.execute({ task_group_id: "1", fixed_issue_ids: [issueId] }, d))
    expect(r2.status).toBe("ok")

    s = readState(wt, CID)
    const tg2 = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    const is2 = tg2.phases.review.issues.find((i: any) => i.id === issueId)
    expect(is2.status).toBe("submitted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ─── D. Exemption ───

describe("D. Exemption flow", () => {
  test("dev requests exemption → architect grants", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-d-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n- [ ] 1.2 T2\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt), d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({ task_group_id: "1", passed: true, issues: [], execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/F1.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({ task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [] }, v)

    // Create issue, then request exemption
    const sCtx = makeCtx("openspec-reviewer-style", wt)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "style", passed: false,
      issues: [{ severity: "Low", file: "x.java", line: 1, description: "Style", suggestion: "Fix" }],
    }, sCtx)

    let s = readState(wt, CID)
    const tg = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    const issueId = tg.phases.review.issues[0].id

    // Request exemption
    fakeGit.diffs.set(wt, [])
    const r = JSON.parse(await dev_submit.execute({
      task_group_id: "1", request_exempts: [{ issue_id: issueId, reason: "Third party lib" }],
    }, d))
    expect(r.status).toBe("ok")

    s = readState(wt, CID)
    const tg2 = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    const exIssue = tg2.phases.review.issues.find((i: any) => i.id === issueId)
    expect(exIssue.status).toBe("exemption")
    expect(exIssue.exemptReason).toBe("Third party lib")

    // Architect grants
    await arch_exempt_review.execute({ task_group_id: "1", reviews: [{ issue_id: issueId, decision: "grant", reason: "Acceptable" }] }, a)
    s = readState(wt, CID)
    const tg3 = (s!.taskGroups as any[]).find((g: any) => g.id === "1")
    expect(tg3.phases.review.issues.find((i: any) => i.id === issueId).status).toBe("exempted")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ─── G. Guards ───

describe("G. Phase/identity guards", () => {
  test("set_worktree before arch_submit throws", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-g-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    expect(set_worktree.execute({}, o)).rejects.toThrow()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("non-orchestrator calling init throws", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const dev = makeCtx("openspec-developer", "/tmp")
    expect(init.execute({ change_id: CID, current_task_group_id: "1" }, dev)).rejects.toThrow()
  })

  test("wrong agent calls reviewer_submit throws", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-g2-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt), d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({ task_group_id: "1", passed: true, issues: [], execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({ task_group_id: "1", dimension: "task", verified_task_ids: ["1"], failed_task_ids: [] }, v)

    // Architect trying to submit style review → throws
    expect(reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, a)).rejects.toThrow()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("duplicate dimension submission throws", async () => {
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const root = `/tmp/orch-g3-${Date.now()}`
    const wt = join(root, "w")
    mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
    writeFileSync(join(wt, "openspec", "changes", CID, "tasks.md"), `## 1. G1\n\n- [ ] 1.1 T1\n`, "utf-8")
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt), d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt), s = makeCtx("openspec-reviewer-style", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({ task_group_id: "1", passed: true, issues: [], execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" } }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({ task_group_id: "1", dimension: "task", verified_task_ids: ["1"], failed_task_ids: [] }, v)

    // First submission goes
    await reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, s)
    // Second submission throws
    expect(reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, s)).rejects.toThrow()

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
