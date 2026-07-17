/**
 * 验证各 agent 视图包含「操作指引」段。
 * 直接调用 view 函数，用最小 mock 数据断言输出。
 */
import { describe, expect, test, afterAll } from "bun:test"
import { __setGitRunner } from "../src/tools/orchestrate"
import {
  renderOrchestratorView,
  renderArchitectView,
  renderDeveloperView,
  renderToolReviewView,
  renderTaskReviewView,
  renderQualityReviewView,
} from "../src/tools/orchestrate/views"
import type { OrchestrateState, TaskGroupState, TaskItem, IssueItem, BlockerItem, ExecutionBoundary } from "../src/tools/orchestrate/types"
import { REVIEW_DIMENSIONS } from "../src/tools/orchestrate/types"

afterAll(() => { __setGitRunner(null) })

function mockTask(id: string, status: TaskItem["status"] = "open"): TaskItem {
  return { id, specTrace: "", title: `Task ${id}`, status, taskNumber: id, rejectReason: null }
}

function mockIssue(id: string): IssueItem {
  return {
    id, dimension: "architecture", sourcePhase: "quality",
    severity: "Low", file: "src/Test.java", line: 1,
    description: "test", suggestion: "fix",
    status: "open", refixCount: 0,
    rootCauseGuess: null, exemptReason: null, rejectReason: null,
  }
}

function mockState(overrides?: Partial<OrchestrateState>): OrchestrateState {
  return {
    changeId: "test-change",
    baseBranch: "main",
    taskGroups: [],
    taskGroupId: "1",
    status: "in_progress",
    orchestrateId: "test",
    createTime: Date.now(),
    ...overrides,
  } as OrchestrateState
}

function baseTg(overrides?: Partial<TaskGroupState>): TaskGroupState {
  return {
    id: "1",
    status: "task_analysis",
    tasks: [],
    blockers: [],
    issues: [],
    relevantSpecs: [],
    lastFilesChanged: [],
    phases: {
      architect_review: { completed: false },
      review: {
        tool: { completed: false, testResults: "" },
        task: { completed: false },
        quality: { progress: Object.fromEntries(REVIEW_DIMENSIONS.map((d) => [d, "pending"])) as TaskGroupState["phases"]["review"]["quality"]["progress"], retryCount: 0, lastResolvedRetryCount: 0 },
      },
    },
    ...overrides,
  } as TaskGroupState
}

describe("视图「操作指引」段", () => {

  test("renderArchitectView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({ status: "task_analysis", tasks: [mockTask("1")] })
    const output = renderArchitectView(state, tg)
    expect(output).toContain("## 操作指引")
    expect(output).toContain("交叉比对")
    expect(output).toContain("opx_arch_submit")
  })

  test("renderDeveloperView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "dev_impl",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" },
      tasks: [mockTask("1")],
    })
    const output = renderDeveloperView(state, tg)
    expect(output).toContain("## 操作指引")
    expect(output).toContain("opx_dev_submit")
    expect(output).toContain("Task (待完成)")
  })

  test("renderToolReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
    })
    const output = renderToolReviewView(state, tg)
    expect(output).toContain("## 操作指引")
    expect(output).toContain("质量门 skill")
    expect(output).toContain("opx_tool_review_submit")
  })

  test("renderTaskReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      tasks: [mockTask("1", "submitted")],
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes: "" },
    })
    const output = renderTaskReviewView(state, tg)
    expect(output).toContain("## 操作指引")
    expect(output).toContain("Task 产出验证")
    expect(output).toContain("opx_task_review_submit")
  })

  test("renderTaskReviewView 有 notes 时显示实施指引", () => {
    const state = mockState()
    const notes = "需要将文件类型拦截做成通用机制"
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      tasks: [mockTask("1", "submitted")],
      executionBoundary: { allowed_directories: ["src"], allowed_packages: ["com"], notes },
    })
    const output = renderTaskReviewView(state, tg)
    expect(output).toContain("## 实施指引")
    expect(output).toContain(notes)
    expect(output).toContain("校验实施内容是否遵循上方「实施指引」")
  })

  test("renderTaskReviewView 无 notes 时不显示实施指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      tasks: [mockTask("1", "submitted")],
      executionBoundary: null,
    })
    const output = renderTaskReviewView(state, tg)
    expect(output).not.toContain("## 实施指引")
    expect(output).not.toContain("校验实施内容是否遵循上方「实施指引」")
    expect(output).toContain("Task 产出验证")
  })

  test("renderQualityReviewView 含操作指引", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      issues: [mockIssue("1")],
    })
    const output = renderQualityReviewView(state, tg, "openspec-reviewer-architecture")
    expect(output).toContain("## 操作指引")
    expect(output).toContain("opx_quality_review_submit")
    expect(output).toContain("按本维度审查标准")
  })
})

describe("一致性分析 sourcePhase 过滤", () => {
  function mockToolStyleIssue(id: string, severity = "Low"): IssueItem {
    return {
      id, dimension: "style", sourcePhase: "tool",
      severity, file: "src/Foo.java", line: 1,
      description: "tool style issue", suggestion: "fix",
      status: "open", refixCount: 0,
      rootCauseGuess: null, exemptReason: null, rejectReason: null,
    }
  }
  function mockQualityStyleIssue(id: string, severity = "Low"): IssueItem {
    return {
      id, dimension: "style", sourcePhase: "quality",
      severity, file: "src/Foo.java", line: 1,
      description: "quality style issue", suggestion: "fix",
      status: "open", refixCount: 0,
      rootCauseGuess: null, exemptReason: null, rejectReason: null,
    }
  }

  test("quality.style=passed + tool sourcePhase style issue 不报内部矛盾", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      issues: [mockToolStyleIssue("i1")],
    })
    tg.phases.review.quality.progress.style = "passed"
    const output = renderOrchestratorView(state, tg)
    expect(output).not.toContain("review 内部矛盾")
  })

  test("quality.style=passed + quality sourcePhase style issue 报内部矛盾", () => {
    const state = mockState()
    const tg = baseTg({
      status: "review",
      worktreePath: "/wt",
      branchName: "tg-1",
      baseRef: "base",
      lastFilesChanged: ["src/Foo.java"],
      issues: [mockQualityStyleIssue("i1")],
    })
    tg.phases.review.quality.progress.style = "passed"
    const output = renderOrchestratorView(state, tg)
    expect(output).toContain("review 内部矛盾")
  })
})
