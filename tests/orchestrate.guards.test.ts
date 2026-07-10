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
  arch_exempt_review,
  dev_submit,
  reviewer_submit,
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

async function setupToReview(wt: string, fakeGit: FakeGitRunner) {
  const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
       d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
  await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
  await arch_submit.execute({
    task_group_id: "1", passed: true, issues: [],
    execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
  }, a)
  await set_worktree.execute({}, o)
  fakeGit.diffs.set(wt, ["src/T.java"])
  await dev_submit.execute({ task_group_id: "1" }, d)
  await reviewer_submit.execute({
    task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [],
  }, v)
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

  test("architect 调 reviewer_submit → throws", async () => {
    const root = `/tmp/guard-g2-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v)

    await expect(
      reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, a)
    ).rejects.toThrow(/openspec-reviewer-style/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G3: 重复提交 ──

describe("G3. 重复提交守卫", () => {
  test("同维度 reviewer 重复提交 → throws", async () => {
    const root = `/tmp/guard-g3-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt),
         s = makeCtx("openspec-reviewer-style", wt)

    await init.execute({ change_id: CID, current_task_group_id: "1" }, o)
    await arch_submit.execute({
      task_group_id: "1", passed: true, issues: [],
      execution_boundary: { allowed_directories: ["src"], allowed_packages: ["com.t"], notes: "" },
    }, a)
    await set_worktree.execute({}, o)
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v)

    await reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, s)
    await expect(
      reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, s)
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
  test("reviewer_submit 传不存在的 task id → throws", async () => {
    const root = `/tmp/guard-g5-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "task",
        verified_task_ids: ["99"], failed_task_ids: [],
      }, v)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G6: Validator 未提交（留空）的完整性门禁 ──

describe("G6. validator 完整性门禁", () => {
  test("已提交 task 但 verified+failed 均为空 → throws", async () => {
    const root = `/tmp/guard-g6-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "task",
        verified_task_ids: [], failed_task_ids: [],
      }, v)
    ).rejects.toThrow(/以下 submitted task 未被/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

describe("G7. validator 非法 task id in failed_task_ids", () => {
  test("failed_task_ids 含非法 task id → throws", async () => {
    const root = `/tmp/guard-g7-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)

    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "task",
        verified_task_ids: ["1"], failed_task_ids: [{ task_id: "999", reason: "Invalid" }],
      }, v)
    ).rejects.toThrow(/非法 task id/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

describe("G8. validator 走代码维度", () => {
  test("validator 调 reviewer_submit 走代码维度 → throws", async () => {
    const root = `/tmp/guard-g8-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
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
    fakeGit.diffs.set(wt, ["src/T.java"])
    await dev_submit.execute({ task_group_id: "1" }, d)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "task", verified_task_ids: ["1", "2"], failed_task_ids: [],
    }, v)

    await expect(
      reviewer_submit.execute({ task_group_id: "1", dimension: "style", passed: true, issues: [] }, v)
    ).rejects.toThrow(/openspec-reviewer-style/)

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
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "style", passed: false,
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
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await reviewer_submit.execute({
      task_group_id: "1", dimension: "style", passed: false,
      issues: [{ severity: "Low", file: "x.java", line: 1, description: "Style", suggestion: "Fix" }],
    }, sCtx)

    const base = join(wt, ".opencode", ".orchestrate_state", `${CID}.json`)
    let state = JSON.parse(readFileSync(base, "utf-8"))
    const issueId = state.taskGroups.find((g: any) => g.id === "1").phases.review.issues[0].id

    await dev_submit.execute({ task_group_id: "1", request_exempts: [{ issue_id: issueId, reason: "Lib" }] }, d)
    await arch_exempt_review.execute({
      task_group_id: "1", reviews: [{ issue_id: issueId, decision: "grant", reason: "Ok" }],
    }, a)

    await expect(
      dev_submit.execute({ task_group_id: "1", request_exempts: [{ issue_id: issueId, reason: "Again" }] }, d)
    ).rejects.toThrow(/已被豁免/)

    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

// ── G11: reviewer_submit 代码维度参数验证 ──

describe("G11. reviewer_submit 代码维度参数验证", () => {
  test("dimension=test 的 issue 缺 type → throws", async () => {
    const root = `/tmp/guard-g11b-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const tCtx = makeCtx("openspec-reviewer-test", wt)

    await setupToReview(wt, fakeGit)
    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "test", passed: false, test_results: "failed",
        issues: [{ severity: "High", file: "x.java", line: 1, description: "Test fail", suggestion: "Fix" }],
      }, tCtx)
    ).rejects.toThrow(/type/)
  })

  test("dimension=test 的 issue 缺 root_cause_guess → throws", async () => {
    const root = `/tmp/guard-g11c-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const tCtx = makeCtx("openspec-reviewer-test", wt)

    await setupToReview(wt, fakeGit)
    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "test", passed: false, test_results: "failed",
        issues: [{ severity: "High", file: "x.java", line: 1, type: "覆盖不足", description: "Missing test", suggestion: "Add" }],
      }, tCtx)
    ).rejects.toThrow(/root_cause_guess/)
  })

  test("非 test 维度的 issue 缺 suggestion → throws", async () => {
    const root = `/tmp/guard-g11d-${Date.now()}`
    const wt = setupWt(root, join(root, "w"))
    const fakeGit = new FakeGitRunner()
    __setGitRunner(fakeGit)
    const o = makeCtx("openspec-orchestrator", wt), a = makeCtx("openspec-architect", wt),
         d = makeCtx("openspec-developer", wt), v = makeCtx("openspec-validator", wt)
    const sCtx = makeCtx("openspec-reviewer-style", wt)

    await setupToReview(wt, fakeGit)
    await expect(
      reviewer_submit.execute({
        task_group_id: "1", dimension: "style", passed: false,
        issues: [{ severity: "Low", file: "x.java", line: 1, description: "Issue without suggestion" }],
      }, sCtx)
    ).rejects.toThrow(/suggestion/)
  })
})
