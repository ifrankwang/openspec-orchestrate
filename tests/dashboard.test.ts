import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { readDashboardState } from "../src/tools/orchestrate"

const TMP = join("/tmp", "dash-test-" + Date.now())
const STATE_DIR = join(TMP, ".opencode", ".orchestrate_state")

function writeState(changeId: string, data: unknown) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, "current.json"), JSON.stringify({ changeId }))
  writeFileSync(join(STATE_DIR, `${changeId}.json`), JSON.stringify(data, null, 2))
}

const mockState = {
  changeId: "dash-change-001",
  taskGroupId: "tg-1",
  baseBranch: "main",
  createdAt: "2026-07-13T10:00:00.000Z",
  updatedAt: "2026-07-13T10:05:00.000Z",
  taskGroups: [
    {
      id: "tg-1",
      name: "用户登录",
      taskCount: 2,
      status: "dev_impl",
      worktreePath: "/tmp/.worktree/task-group-user-login",
      branchName: "task-group/user-login",
      relevantSpecs: ["auth/login"],
      executionBoundary: {
        allowed_directories: ["src"],
        allowed_packages: ["com.example"],
        notes: "",
      },
      lastFilesChanged: ["AuthController.java"],
      phases: {
        architect_review: { completed: true },
        dev_impl: { completed: false },
        review: {
          completed: false,
          retryCount: 0,
          lastResolvedRetryCount: 0,
          qualityBaselineDone: false,
          tool: { completed: false },
          task: { completed: false },
          quality: {
            completed: false,
            progress: {
              style: { submitted: false, passed: false },
              architecture: { submitted: false, passed: false },
              performance: { submitted: false, passed: false },
              security: { submitted: false, passed: false },
              maintainability: { submitted: false, passed: false },
            },
          },
        },
      },
      tasks: [
        { id: "1", title: "登录接口", taskNumber: "1.1", tasksMdRef: "tasks.md#1.1", specTrace: "spec.md", status: "open", rejectReason: null },
        { id: "2", title: "单元测试", taskNumber: "1.2", tasksMdRef: "tasks.md#1.2", specTrace: "spec.md", status: "verified", rejectReason: null },
      ],
      issues: [
        { id: "10", dimension: "security", severity: "Critical", file: "Auth.java", line: 12, description: "SQL 注入", suggestion: "用参数化", type: null, rootCauseGuess: "直接拼 SQL", status: "open", refixCount: 1, rejectReason: null, exemptReason: null, sourcePhase: "quality" },
        { id: "11", dimension: "style", severity: "Info", file: "Config.java", line: 3, description: "命名不规范", suggestion: null, type: null, rootCauseGuess: null, status: "verified", refixCount: 0, rejectReason: null, exemptReason: null, sourcePhase: "tool" },
      ],
    },
  ],
}

let server: ReturnType<typeof Bun.serve> | null = null

describe("Dashboard", () => {
  beforeAll(() => {
    mkdirSync(TMP, { recursive: true })
  })

  afterAll(() => {
    if (server) server.stop()
    rmSync(TMP, { recursive: true, force: true })
  })

  test("readDashboardState returns null when no state", async () => {
    const result = await readDashboardState(TMP)
    expect(result).toBeNull()
  })

  test("readDashboardState returns projection with correct fields", async () => {
    writeState("dash-change-001", mockState)
    const result = await readDashboardState(TMP)
    expect(result).not.toBeNull()
    const r = result!
    expect(r.active).toBe(true)
    expect(r.changeId).toBe("dash-change-001")
    expect(r.currentTaskGroupId).toBe("tg-1")
    expect(r.baseBranch).toBe("main")
    expect(r.taskGroups).toHaveLength(1)

    const tg = r.taskGroups[0]
    expect(tg.status).toBe("dev_impl")
    expect(tg.lifecycle).toBe("in_progress")
    expect(tg.tasks).toHaveLength(2)
    expect(tg.issues).toHaveLength(2)
    expect(tg.phases.architect_review.completed).toBe(true)
    expect(tg.phases.review.retryCount).toBe(0)
  })

  test("HTTP server returns state JSON", async () => {
    writeState("dash-change-001", mockState)
    const port = 15900 + Math.floor(Math.random() * 500)
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: async () => {
          const data = await readDashboardState(TMP)
          return new Response(JSON.stringify(data ?? { active: false }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const res = await fetch(`http://127.0.0.1:${port}/api/state`)
      const json = await res.json()
      expect(json.active).toBe(true)
      expect(json.changeId).toBe("dash-change-001")
      expect(json.taskGroups[0].lifecycle).toBe("in_progress")
    } finally {
      server?.stop()
      server = null
    }
  })

  test("HTTP server returns active:false when no state", async () => {
    const emptyDir = join(TMP, "empty-" + Date.now())
    mkdirSync(emptyDir, { recursive: true })
    const port = 15900 + Math.floor(Math.random() * 500)
    try {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: async () => {
          const data = await readDashboardState(emptyDir)
          return new Response(JSON.stringify(data ?? { active: false }), {
            headers: { "content-type": "application/json" },
          })
        },
      })

      const res = await fetch(`http://127.0.0.1:${port}/api/state`)
      const json = await res.json()
      expect(json.active).toBe(false)
    } finally {
      server?.stop()
      server = null
    }
  })

  test("task and issue fields projected correctly", async () => {
    writeState("type-test", mockState)
    const r = await readDashboardState(TMP)
    const tg = r!.taskGroups[0]

    const t1 = tg.tasks.find((t: any) => t.id === "1")!
    expect(t1.title).toBe("登录接口")
    expect(t1.status).toBe("open")

    const i1 = tg.issues.find((i: any) => i.id === "10")!
    expect(i1.severity).toBe("Critical")
    expect(i1.refixCount).toBe(1)
    expect(i1.sourcePhase).toBe("quality")

    const i2 = tg.issues.find((i: any) => i.id === "11")!
    expect(i2.sourcePhase).toBe("tool")
  })
})
