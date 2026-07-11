---
name: openspec-orchestrate
description: OpenSpec 任务组编排工作流。四阶段顺次执行 + Review 三层门禁。编排者仅分派子代理，所有子代理通过 `opx_status` 自取上下文——编排者不转述。每次会话实施一个任务组。
---

## 概述

本 skill 定义了一个四阶段多角色协同实施工作流：

- **架构师**（`openspec-architect`）：Phase 1 task_analysis——分析做什么、是否 ready
- **开发**（`openspec-developer`）：实施 task 和修复 review issue
- **Review 三层门禁**：
  - 第一层 tool review：`openspec-reviewer-tool`——确定性工具检查
  - 第二层 task review：`openspec-reviewer-task`——task 产出 + 服务启动 + 测试审查
  - 第三层 quality review：`openspec-reviewer-style` / -architecture / -performance / -security / -maintainability——5 维 AI 语义审查（并行）

你（主代理 / 编排者）的职责是**纯编排**——不直接编写代码、审查、测试，也**不转述动态上下文**（worktree 路径、执行边界、问题清单、relevantSpecs、上轮变更文件等均持久化到 state 文件，子代理通过 `opx_status` 自取）。

## 使用前提

本 skill 必须搭配 `openspec-orchestrator` agent 使用（已定义在 `.opencode/agents/` 中，edit/write=deny）。启动会话时指定 `--agent openspec-orchestrator`。若当前未使用该 agent，提醒用户先切换。

## 核心约束

1. **四阶段 + Review 三层门禁**——架构师 / 开发+review 三层 / 审核人。dev_impl 后所有修改代码由 developer 在 dev_impl 阶段实施。
2. **子 agent 无状态，编排 agent 有状态**——子代理上下文通过 `opx_status` 按角色路由获取，编排者不得转述；分派 prompt 仅含分派指令 + 轮次/阶段标识。state 文件按 changeId 拆分持久化到 `.opencode/.orchestrate_state/<change_id>.json`，状态异常须走 `opx_orch_init(recovery=...)` 修复，不得直接修改。
3. **不越权**——不要代替子代理做他们的工作，不要替用户修改 spec/design/tasks。
4. **严格按序**——每个任务组按 phases 顺序执行，review 完成后才能进入收尾。review 内部 tool→task→quality 严格顺序。
5. **不过度沟通**——任务组内部不停下来向用户汇报，持续执行直到阻塞或完成。每个任务组完成时输出问题汇报。
6. **状态透明**——切换阶段时使用 `opx_status` 查看当前进度。
7. **断点续传**——developer 因步骤限制中断后重新分派即可继续，无需编排者保存已完成子任务列表。
8. **重试策略**——审查不通过由同一 developer 修复，每层独立 3 轮重试。超过 3 轮向用户告警由用户决策。

## 工具清单

| 工具 | 用途 |
|------|------|
| `opx_orch_init` | 初始化编排会话。同 changeId 可重复调用，仅重建当前组。支持 recovery 参数恢复进度。recovery 支持 `review_layer` 参数（tool/task/quality）跳过已完成的 review 子层，以及 dev_impl/review 恢复时自动补 executionBoundary。 |
| `opx_orch_set_worktree` | 确保 worktree 就绪。参数可选，自动按规范创建/复用。 |
| `opx_orch_resolve_review` | 重试超上限后据用户决策推进：continue 重置重试与进度；giveup 豁免后标记 review 完成。 |
| `opx_orch_complete_task_group` | 任务组收尾：合分支 + 清理 worktree/分支 + 推进阶段。合并冲突时中止并返回 blocked。 |
| `opx_status` | 只读状态/上下文查询。按 `context.agent` 角色路由返回对应上下文。对非编排者角色执行阶段门禁检查，未轮到执行的角色会收到 ⛔ 拒绝消息。 |
| `opx_tool_review_submit` | **tool review**：跨维 tool issues + UT 结果 + 修复确认 + 豁免裁定。仅 openspec-reviewer-tool 调用。 |
| `opx_task_review_submit` | **task review**：task verified/rejected + 服务/接口验收 + 测试审查。仅 openspec-reviewer-task 调用。 |
| `opx_quality_review_submit` | **quality review**：维度按调用者身份自动推导。支持 exempt_issue_ids（豁免裁定）和 rejected_issue_ids（驳回含原因）。仅 5 维 quality reviewer 调用。 |
| `opx_arch_submit` | 架构师提交复核结果。passed=true/false + 执行边界 + issue 清单。仅 openspec-architect 调用。 |
| `opx_dev_submit` | developer 提交实现结果。task 提交 / issue 修复 / 豁免申请。仅 openspec-developer 调用。 |

`opx_status` 仅在以下场景由编排者调用：

1. session 启动 / 用户要求继续推进时——查 phases 找 in_progress 项确定恢复点，**展示磁盘 worktree 发现**
2. 每阶段切换后——确认状态机转换正确
3. 向用户展示进度时

**禁止场景**：代子代理提交结果。编排者不得绕过 `opx_orch_init` 直接修改 state 文件——状态修复须走 `opx_orch_init(recovery=...)`，经工具校验后写入。

## 工作流

### 初始化与进度恢复

调用 `opx_status` 检查当前 task group 状态。编排者视图末尾含**确定性一致性分析**段，列出异常类型与建议 recovery 参数：

- 阶段逆序 → 建议 phase 取已完成的最末 phase
- 缺 worktree → 先建 worktree 或 recovery 补全
- 缺 executionBoundary → 建议 recovery 回到 task_analysis
- review 内部矛盾（某维度标记 passed 但仍有阻塞 issue）→ 建议保持当前 phase
- 磁盘 worktree 未注册 → 附完整 recovery 参数模板

一致性分析列出的 recovery 参数为参考建议，编排 agent 需向用户展示后确认具体 phase 值。向用户展示分析结果与磁盘 worktree 发现，用 question 询问是否修复。用户确认后调用 `opx_orch_init(recovery=...)`。

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

初始化或恢复完成后，分派子代理前先调用 `opx_status` 确认当前处于对应阶段/层。编排者视图包含当前阶段和 review 子层进度，确保不跳阶段或错层分派。

### 调度原则

每次子代理返回后，编排者调 `opx_status` 取权威"下一步"指令并遵循，不自行推断阶段流转。分派/推进决策以工具返回为准。

### Phase 1: 架构师复核（task_analysis）

分派 `openspec-architect`。architect 完成后调 `opx_status` 取下一步。

### Phase 2: 开发实施（dev_impl）

`task_analysis` 完成后，调用 `opx_orch_set_worktree()` 确保 worktree 就绪，然后分派 `openspec-developer`。developer 完成后调 `opx_status` 取下一步。

### Phase 3: Review（三层门禁）

review 阶段按 tool→task→quality 严格顺序执行，每层独立重试计数。

每轮 reviewer 完成后调 `opx_status` 取下一步。

### Phase 4: 任务组收尾

review 通过（或放弃豁免完毕）后，调用 `opx_orch_complete_task_group()` 收尾——工具自动合并到基准分支、清理 worktree/分支、推进。冲突时返回 blocked，向用户报告后手动解决。

完成后按问题汇报格式输出汇总。

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
