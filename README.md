# openspec-orchestrate

OpenCode 编排插件，实现 OpenSpec 三层架构工作流。

## 架构

```
架构师 (Architect) ──→ 开发+验证 (Developer + Validator) ──→ 6 维审核 (Reviewers)
```

编排者（orchestrator）只负责分派子代理，不自已写代码、审查或测试。

### 三阶段状态机

每个 task group 按序执行：

`architect_review → developer_implement → review → completed`

多 task group 顺序执行，完成后自动推进到下一个未开始组。

### 7 维审查体系

| 阶段 | 维度 | 职责 |
|------|------|------|
| Phase 2 | task (Validator) | 验证 task 产出，校验 verified/failed 完整性 |
| Phase 3 | style / architecture / performance / security / maintainability / test | 代码审查，test 额外要求 type + root_cause_guess |

review 最多 3 轮重试，超限后由用户决策（continue / giveup）。

## 快速开始

### 安装

```bash
# 在 OpenCode 项目中将此插件加入依赖
bun add @opencode-ai/openspec-orchestrate
```

### 使用

1. 在 OpenCode 配置中注册插件
2. 编排者发起 `opx_orch_init` 初始化流程
3. 三阶段自动化执行：架构设计 → 开发实现 → 多维审查

## 命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查 |

## 项目结构

```
src/
  index.ts              — 插件入口（注册 9 个 opx_* 工具 + opx_skill）
  tools/orchestrate.ts  — 全部编排逻辑
  agents/loader.ts      — 注入 agent 配置
  skills/tool.ts        — 加载内置 skill
  skills/loader.ts      — 注入 skill
assets/
  agents/               — 10 个 agent MD 定义
  skills/               — 内置 skill 定义
tests/                  — Bun test，100% fake-git 无外部依赖
```

## 核心特性

- **状态持久化**：按 changeId 拆分状态文件，current.json 指针追踪活跃变更
- **Worktree 隔离**：`git worktree` 分支隔离，自动合并清理
- **执行边界**：架构师限定 developer 的目录和包范围，reviewer 新报 issue 自动扩展
- **豁免机制**：issue → developer 申请豁免 → architect 裁定
- **校验守卫**：多维度校验确保流程完整性

## 关键技术约定

- 工具前缀 `opx_`
- Agent 命名模式 `openspec-{role}`
- Orchestrator mode=primary，其余 mode=subagent
- Orchestrator 仅允许 opx_* 工具和 git/ls/find/grep 命令

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试基于 `FakeGitRunner` 伪造 Git，零外部依赖。
