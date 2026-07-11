/**
 * 编排守卫测试：阶段校验、身份校验、重复提交校验
 *
 * 与 flow test 分离——这些测试校验工具的门禁逻辑，非完整流程场景。
 * 每项测试针对单一守卫条件，不依赖完整流程上下文。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  init,
  set_worktree,
  arch_submit,
  dev_submit,
  tool_review_submit,
  task_review_submit,
  quality_review_submit,
  __setGitRunner,
} from "../src/tools/orchestrate"
import { FakeGitRunner, makeCtx } from "./helpers"

const CID = "test-guard"
afterAll(() => { __setGitRunner(null) })

function setupWt(root: string, wt: string): string {
  mkdirSync(join(wt, "openspec", "changes", CID), { recursive: true })
  writeFileSync(
    join(wt, "openspec", "changes", CID, "tasks.md"),
    `## 1. G1\n\n- [ ] 1.1 T1 [spec:s1]\n- [ ] 1.2 T2\n`,
    "utf-8"
  )
  return wt
}

function readStateSync(wt: string, cid: string): any {
  const p = join(wt, ".opencode", ".orchestrate_state", `${cid}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8"))
}

async function setupToReview(wt: string, fakeGit: FakeGitRunner) {
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
  fakeGit.diffs.set(wt, ["src/T.java"])
  await dev_submit.execute({ task_group_id: "1" }, d)

  // Transition to review + tool + task
  const state = readStateSync(wt, CID)
  const tg = state.taskGroups.find((g: any) => g.id === "1")
  await init.execute({
    change_id: CID, current_task_group_id: "1",
    recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
  }, o)
  await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
  await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
}

// ── G1: set_worktree before arch_submit ──

describe("G1. set_worktree 守卫", () => {
  test("arch_submit 未完成时调用 set_worktree → throws", async () => {
    const root = `/tmp/guard-g1-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await expect(set_worktree.execute({}, o)).rejects.toThrow(
      /architect_review 完成后/
    )

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G2: 身份守卫 ──

describe("G2. 身份守卫", () => {
  test("non-orchestrator 调 init → throws", async () => {
    const dev = makeCtx("openspec-developer", "/tmp")
    await expect(init.execute({ change_id: CID, current_task_group_id: "1" }, dev)).rejects.toThrow(
      /仅限编排者/
    )
  })

  test("architect 调 quality_review_submit → throws", async () => {
    const root = `/tmp/guard-g2-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review + tool + task
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    await expect(
      quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, a)
    ).rejects.toThrow(/openspec-reviewer-style/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G3: 重复提交 ──

describe("G3. 重复提交守卫", () => {
  test("同维度 quality reviewer 重复提交 → throws", async () => {
    const root = `/tmp/guard-g3-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt),
         s = makeCtx("openspec-reviewer-style", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review + tool + task
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    await quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, s)
    await expect(
      quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, s)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G4: passed=true 带 blocking issues ──

describe("G4. assertPassWithIssues 守卫", () => {
  test("arch_submit(passed=true) 带 Low+ issue → throws", async () => {
    const root = `/tmp/guard-g4-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await expect(
      arch_submit.execute({
        task_group_id: "1", passed: true, issues: [
          { file: "d.md", line: 1, type: "缺失", severity: "Medium", description: "Missing", suggestion: "Add" },
        ],
      }, a)
    ).rejects.toThrow(/passed.*true.*issues/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G5: 非法 task id ──

describe("G5. 非法 task id 守卫", () => {
  test("task_review_submit 传不存在的 task id → throws", async () => {
    const root = `/tmp/guard-g5-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({
        task_group_id: "1", passed: true,
        verified_task_ids: ["99"], failed_task_ids: [],
        fixed_issue_ids: [],
      }, taskR)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G6: task_review_submit 完整性门禁 ──

describe("G6. task_review_submit 完整性门禁", () => {
  test("已提交 task 但 verified+failed 均为空 → throws", async () => {
    const root = `/tmp/guard-g6-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({
        task_group_id: "1", passed: true,
        verified_task_ids: [], failed_task_ids: [],
        fixed_issue_ids: [],
      }, taskR)
    ).rejects.toThrow(/以下 submitted task 未被/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G7: 非法 task id in failed_task_ids ──

describe("G7. 非法 task id in failed_task_ids", () => {
  test("failed_task_ids 含非法 task id → throws", async () => {
    const root = `/tmp/guard-g7-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review + tool pass
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      task_review_submit.execute({
        task_group_id: "1", passed: false,
        verified_task_ids: ["1"], failed_task_ids: [{ task_id: "999", reason: "Invalid" }],
        fixed_issue_ids: [],
      }, taskR)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G8: tool 层未完成时 task 层不可提交 ──

describe("G8. tool 层完成守卫", () => {
  test("tool 层未完成时调用 task_review_submit → throws", async () => {
    const root = `/tmp/guard-g8-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review (without tool layer)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await expect(
      task_review_submit.execute({
        task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
        fixed_issue_ids: [],
      }, taskR)
    ).rejects.toThrow(/tool 层审核未完成/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G9: dev_submit 非法参数 ──

describe("G9. dev_submit 非法参数", () => {
  test("request_exempts 含不存在的 issue id → throws", async () => {
    const root = `/tmp/guard-g9-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await quality_review_submit.execute({
      task_group_id: "1", passed: false,
      issues: [{ severity: "Low", file: "x.java", line: 1, description: "Style", suggestion: "Fix" }],
    }, sCtx)

    await expect(
      dev_submit.execute({ task_group_id: "1", request_exempts: [{ issue_id: "fake-id", reason: "Test" }] }, d)
    ).rejects.toThrow(/不在.*issue 清单/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G10: 重复操作守卫 ──

describe("G10. 重复操作守卫", () => {
  test("已豁免的 issue 重复申请豁免 → throws", async () => {
    const root = `/tmp/guard-g10-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)

    await setupToReview(wt, fakeGit)

    // Quality: all pass with Info issue (non-blocking → passed=true works)
    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "x.java", line: 1, description: "Info issue", suggestion: "Consider" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    const base = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
    let state = JSON.parse(readFileSync(base, "utf-8"))
    const issueId = state.taskGroups.find((g: any) => g.id === "1").issues[0].id

    // dev_submit in review: request exemption
    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true },
    }, o)
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Lib" }] }, d)

    // dev_submit reset layers. Re-run tool+task with exemption.
    const s2 = readStateSync(wt, CID)
    const tg2 = s2.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg2.worktreePath, branch_name: tg2.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({
      task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [],
      exempt_issue_ids: [issueId],
    }, toolR)
    await task_review_submit.execute({
      task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [],
      fixed_issue_ids: [],
    }, taskR)

    // Now issue is exempted. Try duplicate exemption → throws.
    await expect(
      dev_submit.execute({ task_group_id: "1", request_exempts: [{ issue_id: issueId, reason: "Again" }] }, d)
    ).rejects.toThrow(/已被豁免/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G11: quality_review_submit 维度参数验证 ──

describe("G11. quality_review_submit 参数验证", () => {
  test("非 tool 维度的 issue 缺 suggestion → throws", async () => {
    const root = `/tmp/guard-g11-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt),
         taskR = makeCtx("openspec-reviewer-task", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await expect(
      quality_review_submit.execute({
        task_group_id: "1", passed: false,
        issues: [{ severity: "Low", file: "x.java", line: 1, description: "Issue without suggestion" }],
      }, sCtx)
    ).rejects.toThrow(/suggestion/)
  })

  test("tool_review_submit 的 issue 缺 dimension → throws", async () => {
    const root = `/tmp/guard-g11b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    // Transition to review (tool NOT completed)
    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await expect(
      tool_review_submit.execute({
        task_group_id: "1", passed: false,
        issues: [{ severity: "High", file: "x.java", line: 1, description: "Issue without dimension" }] as any,
      }, toolR)
    ).rejects.toThrow(/dimension/)
  })
})

// ── G12: task 层未完成时 quality 层不可提交 ──

describe("G12. task 层完成守卫", () => {
  test("task 层未完成时调用 quality_review_submit → throws", async () => {
    const root = `/tmp/guard-g12-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await expect(
      quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/task 层审核未完成/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G13: tool 层重复提交守卫 ──

describe("G13. tool 层重复提交守卫", () => {
  test("tool 层完成后再次提交 → throws", async () => {
    const root = `/tmp/guard-g13-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await expect(
      tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G14: task 层重复提交守卫 ──

describe("G14. task 层重复提交守卫", () => {
  test("task 层完成后再次提交 → throws", async () => {
    const root = `/tmp/guard-g14-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    await expect(
      task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    ).rejects.toThrow(/不允许重复提交/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G15: 豁免完整性门禁 ──

describe("G15. 豁免完整性门禁", () => {
  test("存在 exemption 但未传入 exempt_issue_ids 或 rejected_issue_ids → throws", async () => {
    const root = `/tmp/guard-g15-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const s1 = readStateSync(wt, CID)
    const tg1 = s1.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg1.worktreePath, branch_name: tg1.branchName, preserve_progress: true },
    }, o)
    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    await task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)

    const dims = ["style", "architecture", "performance", "security", "maintainability"]
    for (let i = 0; i < dims.length; i++) {
      const args: any = { task_group_id: "1", passed: true, issues: [] }
      if (i === 0) {
        args.issues = [{ severity: "Info", file: "x.java", line: 1, description: "Style info", suggestion: "Consider" }]
      }
      await quality_review_submit.execute(args, makeCtx(`openspec-reviewer-${dims[i]}`, wt))
    }

    const s2 = readStateSync(wt, CID)
    const issueId = s2.taskGroups.find((g: any) => g.id === "1").issues[0].id

    const devWt = s2.taskGroups.find((g: any) => g.id === "1").worktreePath
    fakeGit.diffs.set(devWt, [])
    await dev_submit.execute({
      task_group_id: "1",
      fixed_issue_ids: [issueId],
      request_exempts: [{ issue_id: issueId, reason: "Trivial" }],
    }, d)

    const s3 = readStateSync(wt, CID)
    const tg3 = s3.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg3.worktreePath, branch_name: tg3.branchName, preserve_progress: true },
    }, o)

    await expect(
      tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)
    ).rejects.toThrow(/未被 fixed_issue_ids、exempt_issue_ids 或 rejected_issue_ids 覆盖/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G16: tool/task 层失败回退 dev_impl ──

describe("G16. 层失败回退 dev_impl", () => {
  test("tool 层 failed → status 变为 dev_impl，后续层级调用被拒", async () => {
    const root = `/tmp/guard-g16a-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    const toolOut = await tool_review_submit.execute({ task_group_id: "1", passed: false, issues: [], fixed_issue_ids: [] }, toolR)
    const r = typeof toolOut === "string" ? toolOut : toolOut.output
    const parsed = JSON.parse(r)
    expect(parsed.status).toBe("rejected")
    expect(parsed.phase).toContain("dev_impl")

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.phases.review.tool.retryCount).toBe(1)

    await expect(
      task_review_submit.execute({ task_group_id: "1", passed: true, verified_task_ids: ["1", "2"], failed_task_ids: [], fixed_issue_ids: [] }, taskR)
    ).rejects.toThrow(/需在 review 阶段调用/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })

  test("task 层 failed → status 变为 dev_impl，后续层级调用被拒", async () => {
    const root = `/tmp/guard-g16b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    // task fails — rely on state assertions for type safety
    const toolOut = await task_review_submit.execute({
      task_group_id: "1", passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Incomplete" }],
      fixed_issue_ids: [],
    }, taskR)
    const jsonStr = typeof toolOut === "string" ? toolOut : toolOut.output
    const parsed = JSON.parse(jsonStr)
    expect(parsed.status).toBe("rejected")
    expect(parsed.phase).toContain("dev_impl")

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.status).toBe("dev_impl")
    expect(tg2.phases.review.task.retryCount).toBe(1)

    await expect(
      quality_review_submit.execute({ task_group_id: "1", passed: true, issues: [] }, makeCtx("openspec-reviewer-style", wt))
    ).rejects.toThrow(/需在 review 阶段调用/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G17: rejectReason 存储 ──

describe("G17. rejectReason 存储", () => {
  test("task 驳回时 rejectReason 正确写入", async () => {
    const root = `/tmp/guard-g17-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    await tool_review_submit.execute({ task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [] }, toolR)

    await task_review_submit.execute({
      task_group_id: "1", passed: false,
      verified_task_ids: ["1"], failed_task_ids: [{ task_id: "2", reason: "Output file not found at expected path" }],
      fixed_issue_ids: [],
    }, taskR)

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    const failedTask = tg2.tasks.find((t: any) => t.id === "2")
    expect(failedTask.status).toBe("rejected")
    expect(failedTask.rejectReason).toBe("Output file not found at expected path")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G18: tool_review_submit test_results 参数 ──

describe("G18. tool_review_submit test_results 参数", () => {
  test("提交时携带 test_results 并正确写入 state", async () => {
    const root = `/tmp/guard-g18-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt),
         toolR = makeCtx("openspec-reviewer-tool", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    const state = readStateSync(wt, CID)
    const tg = state.taskGroups.find((g: any) => g.id === "1")
    await init.execute({
      change_id: CID, current_task_group_id: "1",
      recovery: { phase: "review", worktree_path: tg.worktreePath, branch_name: tg.branchName, preserve_progress: true },
    }, o)

    const result = await tool_review_submit.execute({
      task_group_id: "1", passed: true, issues: [], fixed_issue_ids: [],
      test_results: "Tests run: 42, Passed: 42, Failed: 0",
    }, toolR)

    const parsed = typeof result === "string" ? JSON.parse(result) : JSON.parse(result.output)
    expect(parsed.status).toBe("ok")

    const state2 = readStateSync(wt, CID)
    const tg2 = state2.taskGroups.find((g: any) => g.id === "1")
    expect(tg2.phases.review.tool.testResults).toBe("Tests run: 42, Passed: 42, Failed: 0")

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
