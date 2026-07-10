# openspec-orchestrate

## 这是什么

OpenCode 编排插件，实现 OpenSpec 三层架构工作流：架构师 → 开发+Validator → 6 维审核人。编排者只分派子代理，不自已写代码/审查/测试。

## 快速命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查（tsc --noEmit） |

没有 tsconfig.json——Bun 使用默认配置。

## 项目结构

```
src/index.ts          — 插件入口（注册 9 个 opx_* 工具 + opx_skill）
src/tools/orchestrate.ts — 全部编排逻辑（2071 行，单体文件）
src/agents/loader.ts  — 从 assets/agents/*.md 注入 agent 配置
src/skills/tool.ts    — 从 assets/skills/*/SKILL.md 加载内置 skill
assets/agents/        — 10 个 agent MD 定义（含 frontmatter，mode=primary 仅 orchestrator）
assets/skills/        — 内置 skill（含 openspec-orchestrate 主 skill）
tests/                — Bun test，100% fake-git（无真实 git 依赖）
```

## 核心架构

### 状态持久化

`.opencode/.orchestrate_state/<change_id>.json` — 按 changeId 拆分。`current.json` 指针记录当前活跃 change。

### 三阶段状态机

每个 task group：`architect_review → developer_implement → review → completed`

多 task group 顺序执行，`complete_task_group` 自动推进到下一个 `not_started` 组。

### 7 维审查体系

- **task**（Validator）：Phase 2 验证 task 产出，校验 `verified_task_ids` + `failed_task_ids` 完整性
- **style / architecture / performance / security / maintainability / test**：Phase 3 代码审查，test 维度额外要求 `type` + `root_cause_guess`

review 最多 3 轮重试，超限由用户决策（`opx_orch_resolve_review`）：continue（重置重试预算）或 giveup（豁免残留）。

### 子代理上下文机制

编排者**不得**向子代理转述 worktree 路径、执行边界、issue 清单等动态上下文。分派 prompt 仅含分派指令 + 轮次/阶段标识。子代理通过 `opx_status` 按角色自取。

### 执行边界

架构师通过 `execution_boundary`（allowed_directories + allowed_packages + notes）限定 developer 的工作范围。Reviewer 新报 issue 涉及的目录会自动扩展边界。

### Worktree 管理

`git worktree` 隔离，分支命名 `task-group/{id}`，路径 `.worktree/task-group-{id}`。`complete_task_group` 自动合并 + 清理。

### 校验守卫

- `assertPassWithIssues`：passed=true 但 issues 含 Low+ 级别时报错
- Validator 必须覆盖所有 submitted task（空 verified+failed 报错）
- 非法 task id / issue id fail-fast
- 重复提交同维度 reviewer 报错
- 非对应 agent 调用工具报错

### 豁免机制

issue → dev 申请豁免（`request_exempts`）→ architect 裁定（grant → exempted / reject → rejected，不可二次申请）。

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试通过 `FakeGitRunner`（`tests/helpers.ts`）伪造 Git，零外部依赖。`__setGitRunner()` 注入。

## 关键约定

- 所有工具以 `opx_` 前缀注册
- Agent 命名模式：`openspec-{role}`（orchestrator / architect / developer / validator / reviewer-{dim}）
- `opx_status` 按 `context.agent` 路由视图（编排者看统计+一致性分析，子代理看各自上下文）
- orchestrator agent mode=primary，其余 mode=subagent
- orchestrator 权限：`edit/write=deny`，仅允许 `opx_*` 工具和 `git`/`ls`/`find`/`grep` 命令
- review 修复轮仅分派 `required_dimensions` 中列出的 reviewer，未激活维度不分派
- 新报 issue 通过 dimension+file+line+description 去重
