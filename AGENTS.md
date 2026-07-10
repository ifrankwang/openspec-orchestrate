# openspec-orchestrate

## 这是什么

OpenCode 编排插件，实现 OpenSpec 四阶段工作流 + Review 三层门禁：架构师 → 开发 → Review（Tool → Task → Quality 5 维）。编排者只分派子代理，不自已写代码/审查/测试。

## 快速命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查（tsc --noEmit） |

没有 tsconfig.json——Bun 使用默认配置。

## 项目结构

```
src/index.ts          — 插件入口（注册 opx_* 工具 + opx_skill）
src/tools/orchestrate.ts — 全部编排逻辑
src/agents/loader.ts  — 从 assets/agents/*.md 注入 agent 配置
src/skills/tool.ts    — 从 assets/skills/*/SKILL.md 加载内置 skill
assets/agents/        — agent MD 定义（含 frontmatter）
assets/skills/        — 内置 skill
tests/                — Bun test，100% fake-git（无真实 git 依赖）
```

## 治理原则

### 工具/Skill/Agent 三者逻辑必须统一一致

工具、skill 文档（SKILL.md）、agent 定义（agent.md）三者描述的是同一套编排逻辑。修改其中任意一个，必须同步更新另外两个。三种文件中的术语、参数名、流程描述、角色职责等必须完全一致，不可因疏漏出现矛盾。

### 实现先改工具，再同步 skill 和 agent

所有编排行为以工具实现为准。skill 和 agent 文档是对工具的说明和指令化封装，不得包含工具未实现的逻辑。

### Agent 定义不含实现细节

agent.md 只描述角色的职责边界和可调用工具，不描述编排流程细节（状态机、状态持久化、重试策略等）。编排细节由 orchestrator 通过 skill 文档管理。

### Agent/Skill 不赘述工具已实现的逻辑

工具代码实现了参数校验、状态转换、维度推导、涉敏逻辑等。agent.md 和 SKILL.md 中不得重复描述这些工具内部行为——子代理调用工具后按工具返回的错误消息处理即可。提示词仅需告知"调用 xxx 工具提交"或"按工具提示实施"，不需要解释工具内部做了什么。

### 子代理上下文不得转述

编排者不得向子代理转述 worktree 路径、执行边界、issue 清单等动态上下文。分派 prompt 仅含分派指令 + 轮次/阶段标识。子代理通过 `opx_status` 按角色自取。

### 命名规范

- 所有工具以 `opx_` 前缀注册
- Agent 命名模式：`openspec-{role}`（orchestrator / architect / developer / reviewer-tool / reviewer-task / reviewer-{dim}）
- `opx_status` 按 `context.agent` 路由视图
- orchestrator agent mode=primary，其余 mode=subagent
- orchestrator 权限：`edit/write=deny`，仅允许 `opx_*` 工具和 `git`/`ls`/`find`/`grep` 命令

### review 维度由调用者身份自动推导

`opx_tool_review_submit` / `opx_task_review_submit` / `opx_quality_review_submit` 不接受 `dimension` 参数，维度通过 `DIMENSION_AGENT_MAP` 从 `context.agent` 反查。不允许调用者自行传入维度。`opx_quality_review_submit` 的 5 维 quality reviewer 按调用者身份自动推导，`opx_tool_review_submit` 跨维提交时由工具 reviewer 自行指定 issue 的 `dimension` 字段。

### 豁免按"谁提谁裁定"原则

提出 issue 的角色负责裁定该 issue 的豁免申请。Phase 3 tool review 由 openspec-reviewer-tool 裁定，task review 由 openspec-reviewer-task 裁定，quality review 由对应维度 quality reviewer 裁定。架构师仅以 architecture reviewer 身份通过 `opx_quality_review_submit(exempt_issue_ids=[...])` 裁定自己报的 issue。

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试通过 `FakeGitRunner`（`tests/helpers.ts`）伪造 Git，零外部依赖。`__setGitRunner()` 注入。

## 升级后清除本地缓存

OpenCode 本地缓存插件的位置在 `~/.cache/opencode/packages/github:ifrankwang/`。发布新版本后重启 OpenCode 不会自动清除缓存，需手动删除：

```bash
rm -rf ~/.cache/opencode/packages/github:ifrankwang/openspec-orchestrate
```

否则 OpenCode 仍加载旧版缓存，导致修改不生效。
