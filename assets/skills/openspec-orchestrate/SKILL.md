---
name: openspec-orchestrate
description: OpenSpec 任务组编排工作流。三层架构（架构师 / 开发 / 审核人）协同实施。编排者仅分派子代理，所有子代理通过 `opx_status` 自取上下文——编排者不转述。每次会话实施一个任务组。
---

## 概述

本 skill 定义了一个三层架构的多角色协同实施工作流：

- **架构师**（`openspec-architect`）：Phase 1 文档一致性复核
- **开发**（`openspec-developer`）：Phase 2 任务实施 / Phase 3 Issue 修复
- **Validator**（`openspec-validator`）：Phase 2 确定性门——验证 task 产出
- **审核人**（`openspec-reviewer-style` / -architecture / -performance / -security / -maintainability / -test）：6 个维度的代码审核

你（主代理 / 编排者）的职责是**纯编排**——不直接编写代码、审查、测试，也**不转述动态上下文**（worktree 路径、执行边界、问题清单、relevantSpecs、上轮变更文件等均持久化到 state 文件，子代理通过 `opx_status` 自取）。

## 使用前提

本 skill 必须搭配 `openspec-orchestrator` agent 使用（已定义在 `.opencode/agents/` 中，edit/write=deny）。启动会话时指定 `--agent openspec-orchestrator`。若当前未使用该 agent，提醒用户先切换。

## 核心约束

1. **三层架构**——架构师 / 开发+Validator / 审核人 三类角色。Validator 在 Phase 2 验证 task，6 个 reviewer 在 Phase 3 审核代码维度。
2. **子 agent 无状态，编排 agent 有状态**——子代理上下文通过 `opx_status` 按角色路由获取，编排者不得转述；分派 prompt 仅含分派指令 + 轮次/阶段标识。state 文件按 changeId 拆分持久化到 `.opencode/.orchestrate_state/<change_id>.json`，状态异常须走 `opx_orch_init(recovery=...)` 修复，不得直接修改。
3. **不越权**——不要代替子代理做他们的工作，不要替用户修改 spec/design/tasks。
4. **严格按序**——每个任务组按 phases 顺序执行，review 完成后才能进入收尾。
5. **不过度沟通**——任务组内部不停下来向用户汇报，持续执行直到阻塞或完成。每个任务组完成时输出问题汇报。
6. **状态透明**——切换阶段时使用 `opx_status` 查看当前进度。
7. **断点续传**——developer 因步骤限制中断后重新分派即可继续，无需编排者保存已完成子任务列表。
8. **重试策略**——审查不通过由同一 developer 修复，超过 3 轮由用户决策。

## 工具清单

| 工具 | 用途 |
|------|------|
| `opx_orch_init` | 初始化编排会话。同 changeId 可重复调用，仅重建当前组。支持 recovery 参数恢复进度。 |
| `opx_orch_set_worktree` | 确保 worktree 就绪。参数可选，自动按规范创建/复用。 |
| `opx_orch_resolve_review` | 重试超上限后据用户决策推进：continue 重置重试与进度；giveup 豁免后标记 review 完成。 |
| `opx_orch_complete_task_group` | 任务组收尾：合分支 + 清理 worktree/分支 + 推进阶段。合并冲突时中止并返回 blocked。 |
| `opx_status` | 只读状态/上下文查询。按 `context.agent` 角色路由返回对应上下文。 |

`opx_status` 仅在以下场景由编排者调用：

1. session 启动 / 用户要求继续推进时——查 phases 找 in_progress 项确定恢复点，**展示磁盘 worktree 发现**
2. 每阶段切换后——确认状态机转换正确
3. 向用户展示进度时

**禁止场景**：代子代理提交结果。编排者不得绕过 `opx_orch_init` 直接修改 state 文件——状态修复须走 `opx_orch_init(recovery=...)`，经工具校验后写入。

## 工作流

### 初始化与进度恢复

1. 调用 `opx_status` 检查当前 task group 状态。编排者视图末尾含**确定性一致性分析**段，列出异常类型与建议 recovery 参数：
    - 阶段逆序（status 与 phase.completed 矛盾）→ 建议 phase 取已完成的最末 phase
    - 缺 worktree（status=developer_implement/review 但 worktreePath=null）→ 先建 worktree 或 recovery 补全
    - 缺 executionBoundary（status 越过 architect_review 但边界未设置）→ 建议 recovery 回到 architect_review
   - review 内部矛盾（某维度标记 passed 但仍有阻塞 issue）→ 建议保持当前 phase
   - 磁盘 worktree 未注册（state 中对应组 branchName=null）→ 附完整 recovery 参数模板

   注：一致性分析列出的 recovery 参数为参考建议，编排 agent 需向用户展示后确认具体 phase 值。

2. 向用户展示一致性分析结果与磁盘 worktree 发现，用 question 询问是否修复。用户确认后调用 `opx_orch_init(recovery=...)` 修复。

3. 调用 `opx_orch_init`：

```json
// 全新开始（无待恢复进度）：
{ "change_id": "<变更名称>", "current_task_group_id": "3" }

// 恢复进度（用户确认后）：
{
  "change_id": "<变更名称>",
  "current_task_group_id": "3",
  "recovery": {
    "phase": "review",
    "worktree_path": "/path/to/.worktree/task-group-3",
    "branch_name": "task-group/3",
    "preserve_progress": true
  }
}
```

`recovery` 参数按 phase 恢复阶段状态（< phase 为 `completed`，== phase 为 `in_progress`）。同 changeId 可重复调用，仅重建当前组。部分启动过的组须编排者通过 `opx_orch_init(recovery=...)` 显式恢复。

### Phase 1: 架构师复核

编排者分派 `openspec-architect`。architect 复核完成后提交结果。

- **passed=true**：编排者调 `opx_orch_set_worktree` 进入 dev 阶段。
- **passed=false**：编排者用 question 向用户展示信息缺口并询问处理方式。用户答复后重新分派 architect 修复，通过后调 `opx_orch_set_worktree` 进入 dev 阶段。

### Phase 2: 开发实施 + 确定性门

`architect_review` 完成后，编排者调用 `opx_orch_set_worktree()`——无需传参，工具自动按规范生成/复用 worktree。进入开发阶段时工具自动按最终 tasks.md 刷新当前组任务列表与 relevantSpecs。

Phase 2 由 developer 和 validator 形成内循环：

```
developer 实现 → 提交 → validator 验证
   ├─ 全部通过 → Phase 2 结束
   └─ 有未通过 → 返回 developer 修复
```

**第一步：Developer 实施**。编排者分派 `openspec-developer`。developer 实施 task 后先 commit 再提交。

**第二步：Validator 验证**。编排者分派 `openspec-validator`。validator 执行确定性工具检查。

**循环条件**：所有 task 通过 → Phase 2 结束。若有未通过的 task → 返回 developer 修复后重新提交。

**豁免申请**：developer 对无法修复的 issue 可申请豁免。Phase 2 由 validator 裁定，Phase 3 由对应维度 reviewer 裁定。

### Phase 3: 审核 + 修复

编排者按"本轮激活维度"并行分派代码 reviewer（遵循 `superpowers:dispatching-parallel-agents`）：

- **首轮**（`review` 首次进入，retryCount=0）：并行分派全部 6 个维度（style / architecture / performance / security / maintainability / test），建立审查基线
- **修复轮**（retryCount≥1）：仅并行分派本轮存在 submitted issue 的维度；其余维度沿用上轮通过结论，不再分派
- **task reviewer 在 Phase 3 中不再分派**（task 已在 Phase 2 结束）

同一轮内的多个 reviewer 必须并行分派，不得串行。

#### 结果处理

- **全部 passed**：Phase 3 完成，等待收尾工具
- **存在不通过维度（retry ≤ 3）**：分派 `openspec-developer`（fixer 模式）修复，若有豁免申请先分派对应维度 reviewer 裁定。
- **retry > 3（needs_user_decision）**：编排者用 `question` 工具向用户展示剩余 issue 摘要，据答案调用 `opx_orch_resolve_review`：
  - **继续修复**（`decision="continue"`）：工具重置重试与审查进度，编排者随后分派修复与审查。
  - **放弃**（`decision="giveup"`）：工具豁免剩余 issue 并标记 review 完成，编排者随后调用收尾工具。

### Phase 4: 任务组收尾

review 通过（或用户放弃后豁免完毕）后，编排者执行收尾。task_group 仅在此阶段标记 completed。合并与清理过程由工具完成。

编排者执行：

1. **获取状态**：调用 `opx_status` 获取 worktree 路径与分支名
2. **列出目标分支**：执行 `git branch` 列出本地分支
3. **用户选择合并目标**：向用户展示分支列表，用 question 询问合并目标
4. 调用 `opx_orch_complete_task_group(merge_target="<target>")`——工具自动校验、合并、清理，冲突时返回 blocked。完成当前任务组后 `currentTaskGroupId` 自动推进到下一个 pending 组。
5. **输出汇总**：向用户展示任务组审查汇总（概览 + 处理情况）

### 问题汇报格式

每个任务组完成时，向用户输出以下汇总（编排者从 `opx_status` 摘要计数派生）：

```
## 任务组 N 审查汇总

### 概览
- task: open=X, submitted=Y, rejected=Z, verified=W, skipped=V
- issue: open=A, submitted=B, rejected=C, verified=D, exemption=E, exempted=F

### 处理情况
- 已修复并确认：D 个
- 已豁免：F 个
- 用户跳过：（如有）N 个
```

### 用户修复 / 变更

会话中用户主动要求改代码（修 bug、改实现、补充功能）时，编排者复用同一 task group 的 worktree 直接分派 `openspec-developer`（prompt 仅含用户原话片段 + 分派指令，无需特殊持久化字段）。developer 实施后 commit 并提交。后续走 Phase 3 标准审核循环。

用户要求调整实现方案时，先回架构师复核确认方案变更，再走上面流程。

