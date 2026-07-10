---
name: openspec-orchestrate-optimizer
description: >
  编排框架分析与优化。支持两种入口：
  (A) 会话复盘：导出并精简 session（含子代理递归合并，深度上限 5），
  分派子代理读取 session 数据，主代理执行合规分析与 5-Why 根因追溯，输出框架改进建议；
  (B) 优化项分析：用户直接提出针对编排框架（agent 指令、skill 定义、工具行为、流程阶段）的优化诉求，
  主代理按诉求性质分流（问题导向 5-Why / 改进导向 现状-差距-方案），输出改进建议。
  Use when user wants to analyze or review an orchestration session, optimize the
  orchestrate workflow, perform a retrospective, or 提出针对编排框架的优化项.
  Triggers on: "分析编排", "复盘 session", "优化 orchestrate", "审查编排质量",
  "找出编排问题", "orchestrate_optimizer", 提供一个 sessionID 用于导出分析,
  或直接提出针对编排框架/agent/skill/工具/流程的改进或问题诉求.
argument-hint: "[sessionID]"
---

编排框架分析与优化。主代理负责编排分析流程、推理与判断，子代理负责重 I/O 读取。本 skill 不修改任何文件，仅输出分析报告。

## 两种入口

| 入口 | 触发 | 处理文档 |
|------|------|---------|
| 模式 A：Session 分析 | 用户提供 sessionID，或要求复盘/审查某次编排会话 | `reference/session-analysis.md` |
| 模式 B：优化项分析 | 用户直接提出针对编排框架的优化或问题诉求，未提供 sessionID | `reference/optimization-item-analysis.md` |

## 模式判断

收到用户请求时，依据以下信号分流：

- 提供了 sessionID（含 `ses_` 前缀）→ **模式 A**
- 触发词明显指向某次具体会话的复盘（"复盘那个 session""分析刚才的编排"）→ 向用户确认 sessionID 后走 **模式 A**
- 直接描述对编排框架的改进或问题诉求（"Phase 4 太慢""审查员总报同一个问题""给 architect 加个边界约束"）→ **模式 B**
- 信号模糊（既像复盘诉求又像框架优化，或表述不清）→ 用 question 工具向用户澄清：你想分析某次具体会话的执行情况，还是直接对编排框架提一项优化？得到回答后再分流

确定模式后，**读取对应的 reference 文件**并按其完整流程执行：

- 进入模式 A：读取 `reference/session-analysis.md`
- 进入模式 B：读取 `reference/optimization-item-analysis.md`

## 共用步骤概要

两种模式共享以下步骤，详细约束见各自 reference 文件：

- **理解编排规范**：读取 `.opencode/skills/openspec-orchestrate/SKILL.md` 与 `.opencode/agents/openspec-orchestrator.md`，提取约束清单（模式 A 额外需信号映射）
- **收集相关文件**：分派 explore 子代理并发读取目标文件，子代理只返回结构化摘要
- **改进建议**：每条建议必须指名具体文件路径和章节/行号；提出前必须读取目标文件当前内容；建议基于文件实际内容而非推测
- **输出前自检**：逐条确认用户反馈无遗漏、建议指向明确、根因/现状均经交叉验证、所有建议基于已读文件
- **输出报告**：纯段落格式，不落盘

## 共用约束

- 不修改任何文件，仅输出分析报告
- 检查项从编排 skill 动态推导，不写死在 skill 指令中
- 改进建议必须指名具体文件路径和章节/行号
- 5-Why 必须落到系统性根因（skill/agent/工具的设计层面），不落在个案操作失误
- 涉及文件内容的根因/现状描述，均须基于已读文件实际内容，不得凭推测

## 设计偏好

提出改进建议时遵循以下偏好（作为方案取舍依据）：

- **倾向不新增工具，但可调整参数**：优化方案优先在现有工具内部调整参数、返回值或状态转移逻辑；仅当现有工具语义确实无法承载时才考虑新增工具。
- **agent 与编排 skill 保持技术栈无关**：`openspec-orchestrate` skill 及各 agent 定义不得硬编码特定技术栈的名称、构建命令、框架约定或技术栈相关工具（如 Maven）；具体技术栈的使用标准与要求统一放到独立的技术栈 skill 中，由子 agent 按需加载。

## 简洁输出原则

改进建议类输出（两种模式共用）遵循以下原则：

- **结论至上**：只输出问题与方案，不展示分析过程。5-Why 只给根因结论，不给追问链条。
- **扁平结构**：不使用多层章节嵌套（如"合规分析""现状与目标"），每条问题+建议总计不超过 3 行。
- **引用不赘述**：约束性内容在 SKILL.md 正文中权威定义即可，reference 文件不再重复展开注释性说明。

## 共用 Gotchas

- 子代理只负责数据提取，主代理负责分析与判断，不得把判断职责外包给子代理
- 改进建议涉及的文件改动常有多处联动，方案探索/影响评估时需列出受影响的 agent/skill/工具
- 工具逻辑以源码（`.opencode/tools/*.ts`）为准时需注意：声明式行为与运行时行为可能存在差异，怀疑时结合实际调用结果或用户确认后再下结论