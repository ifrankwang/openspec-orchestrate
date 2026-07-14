# openspec-orchestrate

## 快速命令

| 命令 | 用途 |
|------|------|
| `bun test` | 运行所有测试 |
| `bun run typecheck` | TypeScript 类型检查（tsc --noEmit） |

tsconfig.json 已在项目根，typecheck 经 tsc 按其配置严格检查 `src/`。

## 项目结构

```
src/index.ts              — 插件入口（注册 opx_* 工具 + opx_skill）
src/tools/orchestrate.ts        — 编排工具 barrel（re-export）
src/tools/orchestrate/          — 编排逻辑模块目录（types/constants/schemas/git/state/tasks-md/derive/review/views/dashboard/tools-lifecycle/tools-review）
src/agents/loader.ts      — 从 assets/agents/*.md 注入 agent 配置
src/skills/tool.ts        — 从 assets/skills/*/SKILL.md 加载内置 skill
assets/agents/            — agent MD 定义（含 frontmatter）
assets/skills/            — 内置 skill（java-* 技术栈 skill）
tests/                    — Bun test，100% fake-git（无真实 git 依赖）
```

## 编排流程设计

### 阶段架构

四阶段顺次执行 + Review 三层门禁：

| 阶段 | 角色 | 职责 |
|------|------|------|
| Phase 1 task_analysis | `openspec-architect` | 分析做什么、是否 ready |
| Phase 2 dev_impl | `openspec-developer` | 实施 task 及修复 issue |
| Phase 3 review | tool→task→quality | 三层门禁，每层独立重试计数 |
| Phase 4 收尾 | — | 合并分支、清理 worktree、标记 completed |

### 参与者

| Agent | 阶段 | 职责 |
|-------|------|------|
| `openspec-orchestrator` | 全流程 | 分派子代理，不自已写代码/审查/测试 |
| `openspec-architect` | Phase 1 | 架构师复核 |
| `openspec-developer` | Phase 2 | 开发实施 + issue 修复 |
| `openspec-reviewer-tool` | Phase 3 第一层 | 确定性工具检查、编译、UT |
| `openspec-reviewer-task` | Phase 3 第二层 | 产出验证、服务启动、接口测试、测试审查 |
| `openspec-reviewer-style` | Phase 3 第三层 | 代码规范审查 |
| `openspec-reviewer-architecture` | Phase 3 第三层 | 架构审查 |
| `openspec-reviewer-performance` | Phase 3 第三层 | 性能审查 |
| `openspec-reviewer-security` | Phase 3 第三层 | 安全审查 |
| `openspec-reviewer-maintainability` | Phase 3 第三层 | 可维护性审查（含技术债增量） |

### 调度方式

每次子代理返回后，编排者调 `opx_status` 取权威 next-step 指令并遵循。`opx_status` 列出多个子代理时并排分派（单条消息中同时发送），不串行等待。当前阶段/层应分派谁由阶段门禁（`deriveCurrentAgents`）输出，编排者不自行推断流转顺序。

## 治理原则

### 编排流转单一事实源

编排的 next-step（下一步分派谁 / 调用什么工具）由 `opx_status` 工具权威产出。orchestrator agent 定义不得重复描述具体阶段流转顺序，仅描述原则与角色职责边界。工具产出与文档描述之间的冲突以工具为准。

- `openspec-orchestrator.md` 中禁止记录任何具体流程流转相关描述，统一以 `opx_status` 指引为准。
- 工具返回体不得包含流转方向提示（如"请分派 X"、"进入 Y 阶段"），流转决策一律由 `opx_status` 产出。

### 编排改动须评估全流程连锁影响

编排流转是耦合状态机：阶段状态、各层 completed 标志、issue 状态机、blocking 口径相互依赖。分析、设计、实施任何单点改动（工具参数校验/状态转移/门禁判定/层跳过优化）时，必须沿状态机推演该改动对下游全流程的连锁影响，禁止只验证改动点本身是否自洽。

典型联动链：某层 passed 判定 ↔ 回退 dev 后该层是否被重新唤起 ↔ 遗留 issue 归哪一层裁定 ↔ 各门禁处 blocking issue 的状态集合口径是否一致。局部放宽一处校验若未同步下游判定，常在收尾/复裁环节制造状态机死锁。

### 工具/Agent 二者逻辑必须统一一致

工具与 agent 定义描述的是同一套编排逻辑。修改其中任意一个，必须同步更新另一个。术语、参数名、流程描述、角色职责等必须完全一致。

### 实现先改工具，再同步 agent

所有编排行为以工具实现为准。agent 文档是对工具的说明和指令化封装，不得包含工具未实现的逻辑。

### Agent 定义不含实现细节

agent.md 只描述角色的职责边界和可调用工具，不描述编排流程细节（状态机、状态持久化、重试策略等）。编排流程设计见本文档「编排流程设计」节。

### Agent 不赘述工具已实现的逻辑

工具代码实现了参数校验、状态转换、维度推导、涉敏逻辑等。agent.md 中不得重复描述这些工具内部行为——子代理调用工具后按工具返回的错误消息处理即可。提示词仅需告知"调用 xxx 工具提交"或"按工具提示实施"，不需要解释工具内部做了什么。

agent doc 禁止枚举/赘述 `opx_status` 的返回内容（字段清单、"返回了 X"、"不会返回 Y"等）。子代理一律"调用 `opx_status` 自取上下文"，文档中不描述返回项。

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

提出 issue 的角色负责裁定该 issue 的豁免申请。tool review 由 openspec-reviewer-tool 裁定，task review 由 openspec-reviewer-task 裁定，quality review 由对应维度 quality reviewer 裁定。架构师仅以 architecture reviewer 身份通过 `opx_quality_review_submit(exempt_issue_ids=[...])` 裁定自己报的 issue。

### 编排层不涉及被编排 agent 的内部逻辑

orchestrator agent 定义仅描述编排逻辑（分派原则、门禁诊断），不涉及被编排 agent 的审查内容、审查范围、严重级别认定等内部逻辑。这些内容属于各 agent 自身提示词范畴，出现偏差在各 agent 层面修正。

### agent 与技术栈 skill 解耦（单向依赖）

agent 与编排 skill 保持技术栈无关。agent 定义中不得硬编码技术栈名称、构建命令、框架约定、技术栈工具（如 Maven/PMD/ArchUnit）或具体技术栈 skill 名。

agent 只按"能力类别"发起查找：读 available_skills，靠 skill 的 description 语义匹配。找到必加载，找不到则优雅降级并在报告标注。

依赖方向单向为技术栈 skill → agent：反向映射由 skill 的 description/frontmatter 声明（面向哪些 agent、哪个 Phase 生效）。禁止 agent → 具体 skill 的引用。

## 测试

```bash
bun test                    # 全部测试
bun test tests/orchestrate.flow.test.ts  # 单一文件
```

测试通过 `FakeGitRunner`（`tests/helpers.ts`）伪造 Git，零外部依赖。`__setGitRunner()` 注入。

## 同步本地改动到缓存

发布新版本或改完插件代码后，将本地源码同步到 opencode 缓存以生效：

```bash
bun run sync
```

否则 OpenCode 仍加载旧版缓存，导致修改不生效。
