---
name: quality-gate
description: 确定性质量门工具集。Phase 2 validator 加载，用于执行 spotless / ArchUnit / PMD / mvn test / SonarQube 等确定性工具检查，将违规项映射为 tool 类 issue。Phase 3 reviewer 不加载本 skill。
---

## 适用范围

本 skill 仅供 **Phase 2 的 validator** 加载。validator 执行本 skill 中的所有工具检查，并将结果通过 `opx_reviewer_submit(dimension="task")` 提交。

**不适用场景**：
- Phase 3 的 reviewer 不加载本 skill——他们自行按维度审查代码。
- developer 不加载本 skill

## 通用步骤

执行以下工具检查，每步结果须同时报告给编排者（文本描述）。

### 必做检查清单

以下清单枚举 validator 必须完成的所有检查项。每项不可跳跃——要么执行并报告结果，要么在提交报告中注明跳过理由及对应 tool 类 issue：

| 序号 | 检查项 | skill 章节 | 报告要求 |
|------|--------|-----------|---------|
| 1 | 工具环境检查 | 第 0 节 | 逐项报告可用性，不可用须注明降级理由 |
| 2 | 编译检查 | 第 1 节 | 报告 BUILD SUCCESS / FAILURE |
| 3 | 代码格式检查 | 第 2 节 | 报告通过或违规数量 |
| 4 | 架构约束检查 | 第 3 节 | 报告通过或违规数量 |
| 5 | 代码质量检查（PMD） | 第 4 节 | 报告通过或违规数和严重级别 |
| 6 | 单元测试 + 覆盖率 | 第 5 节 | 报告通过率与覆盖率数据 |
| 7 | SonarQube 深度扫描 | 第 6 节 | 报告执行结果或降级理由 |
| 8 | 汇总与提交 | 第 7 节 | 提交 verified / failed task |

## 0. 工具环境检查

在执行工具检查前，先确保工具运行环境就绪。不可用的工具生成 type=tool 的 issue，而非直接报错。

```bash
docker info
docker compose version
curl -sf http://localhost:9000/api/system/status | grep -q UP
sonar-scanner --version
```

| 检查项 | 命令 | 失败时 severity | 处理方式 |
|--------|------|----------------|---------|
| Docker daemon | `docker info` | Critical | Docker daemon 未运行 → tool 类 issue，SonarQube 扫描无法执行 |
| docker-compose | `docker compose version` | Critical | docker-compose 不可用 → tool 类 issue，SonarQube 扫描无法执行 |
| SonarQube 服务 | `curl -sf http://localhost:9000/api/system/status \| grep -q UP` | Critical | SonarQube 服务未健康运行（或未启动）→ tool 类 issue，SonarQube 扫描无法执行 |
| sonar-scanner CLI | `sonar-scanner --version` | Medium | CLI 未安装 → tool 类 issue，SonarQube 扫描降级为跳过（不阻塞其他检查项） |

Docker 或 SonarQube 服务检查失败时后续 SonarQube 扫描章节直接跳过（在提交报告的 `failed_task_ids` 中注明原因），其余工具检查照常执行。sonar-scanner 缺失同理。

## 1. 编译检查

```bash
mvn compile -q
```

- 通过：编译无错误，输出 "BUILD SUCCESS"
- 不通过：→ tool 类 issue，severity=Critical，developer 必须修复

## 2. 代码格式检查

```bash
mvn spotless:check
```

- 通过：无格式违规，输出 "[INFO] Spotless check passed"
- 不通过：→ tool 类 issue，severity=Low，每条违规映射为一个 issue
  - 从 `spotless:check` 输出中提取违规文件路径
  - 修复方式：运行 `mvn spotless:apply`

## 3. 架构约束检查

```bash
mvn test -Dtest="ArchitectureTest"
```

- 通过：所有 ArchUnit 测试通过
- 不通过：→ tool 类 issue，severity=Medium，每条 ArchUnit 违规映射为一个 issue
  - expression: 从测试失败信息中提取违规类名和描述
  - 示例："Domain 层引入 org.springframework.stereotype.Service"

## 4. 代码质量检查

```bash
mvn pmd:check
```

### 阻塞级

PMD 检查返回非 0（有违规）即阻塞 task 完成。以下 PMD 规则集启用：

- `category/java/errorprone.xml`（错误模式：空 catch、compareToEquals 等）
- `category/java/bestpractices.xml`（最佳实践：unused imports、System.out 等）
- `category/java/design.xml`（设计：方法长度、圈复杂度、God class 等）
- `category/java/performance.xml`（性能：String 拼接、冗余对象创建等）

### 违规项 → issue 映射

| PMD 规则 | 优先级 | issue severity | 典型场景 |
|----------|--------|---------------|---------|
| System.out/err | 2 | Medium | `System.out.println(...)` |
| 空 catch 块 | 3 | High | `catch(Exception e) {}` |
| 方法过长 | 3 | Medium | 方法超过 100 行 |
| 圈复杂度过高 | 3 | Medium | CC > 15（方法级）、CC > 20（类级） |
| 未使用变量/import | 3 | Low | import 引用但未使用 |
| String 拼接 | 3 | Low | 循环内 `s += ...` |
| 未关闭资源 | 3 | High | 未使用 try-with-resources |

### 输出解析

PMD 违规输出格式：
```
[WARNING] PMD Failure: <file>:<line> Rule:<rule> Priority:<N> <message>
```

从输出中逐行解析，提取 file / line / rule / message 字段。

## 5. 单元测试 + 覆盖率

```bash
mvn test
```

排除 `ArchitectureTest`（已在步骤 3 单独跑）。

- 通过：所有测试通过
- 不通过：→ tool 类 issue，severity 按测试类型区分
  - 业务逻辑测试失败 → High（功能回归）
  - 新增功能测试失败 → Medium（新代码 Bug）
  - 测试基础设施问题 → Critical（环境问题）

### 覆盖率（JaCoCo）

JaCoCo 已在 `pom.xml` 中配置，`mvn test` 后自动在 `target/site/jacoco/` 下生成报告。解析 `jacoco.csv` 获取覆盖率数据：

```bash
cat target/site/jacoco/jacoco.csv
```

| 字段 | 含义 |
|------|------|
| INSTRUCTION_MISSED/COVERED | 字节码指令覆盖率 |
| BRANCH_MISSED/COVERED | 分支覆盖率 |
| LINE_MISSED/COVERED | 行覆盖率 |

覆盖率不达标 → tool 类 issue。阈值建议：指令覆盖率 < 60% 为 Medium，分支覆盖率 < 50% 为 Low。

## 6. SonarQube 深度扫描

### 前置条件

本地 SonarQube Server 通过 `docker compose -f docker-compose-dev.yaml up -d sonarqube` 启动。

### 配置

`sonar-project.properties` 文件位于项目根目录。

### 执行

```bash
sonar-scanner
```

### 违规项 → issue 映射

| SonarQube severity | issue severity | 处理方式 |
|-------------------|---------------|---------|
| blocker | Critical | 阻塞，必须修复 |
| critical | High | 阻塞，必须修复 |
| major | Medium | 阻塞，必须修复 |
| minor | Low | 阻塞，建议修复 |
| info | Info | 不阻塞 |

SonarQube 规则 6,500+，覆盖 PMD 无法检测的安全漏洞、代码异味、Bug 模式和安全热点。

### 输出解析

从 `sonar-scanner` 输出或 SonarQube API 获取 `issues`，提取：
- `rule`（如 `java:S106`）
- `component`（文件路径）
- `line`（行号）
- `message`（描述）
- `severity`（BLOCKER/CRITICAL/MAJOR/MINOR/INFO）

### 首次运行处理

若为项目首次接入，存量违规项数量可能很大。validator 应：
1. 仅对新增/修改文件中的违规项生成 issue（通过 `git diff --name-only <baseRef>..HEAD` 过滤）
2. 存量违规项报告但不生成 issue（在报告中标注 `[sonar-legacy]` 供后续处理）

## 7. 汇总与提交

所有工具检查完成后，validator 调 `opx_reviewer_submit(dimension="task", ...)` 提交：
- `verified_task_ids`：产出完整的 task
- `failed_task_ids`：产出不完整或因工具违规阻塞的 task
