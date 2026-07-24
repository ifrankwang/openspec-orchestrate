---
name: java-dev-essentials
description: 仅限 Java 后端开发场景。项目开发基础——构建命令、代码质量、测试、日志、提交规范。适用场景：Phase 2 编写代码（backend-developer）、Phase 2 测试审查（test-engineer）、Phase 3 任务验证（task-verifier）、Phase 3 规范审查（code-reviewer-style）。
---

## 构建命令

```bash
mvn verify                            # 全量生命周期
mvn spotless:apply                    # 自动格式化
mvn compile                           # 编译
mvn test                              # 运行测试
```

## 代码质量工具

**Spotless**（Palantir Java Format）：
- 提交前执行 `mvn spotless:apply` 格式化，`mvn spotless:check` 必须通过
- 配置在 pom.xml `spotless-maven-plugin`

**PMD**：
- 规则集涵盖：禁止 System.out、强制 try-with-resources、禁止不必要的内联 FQN（`UnnecessaryFullyQualifiedName`）、方法行数上限 100、类圈复杂度上限 20/方法上限 15
- 规则集定义按项目级 pmd-rules.xml

**SonarLint**：IDE 建议安装 SonarLint 插件，尽量修复提示问题

## .gitignore

必须包含：
```
target/
*.log
.idea/
*.iml
.env
```

## 测试规范

**命名规范**：
- 测试类：`{ClassName}Test`（如 `OrderServiceTest`）
- 测试方法：`test{MethodName}`（如 `testCreateOrder`）

**分层策略**：
- domain service 测试用纯 JUnit，零 Spring 依赖（domain 层本就无框架依赖）
- 优先切片测试 + `@Import` 组装所需 Bean，避免滥用全量 `@SpringBootTest`（启动慢、依赖环境）
- 仅跨多层集成测试时才用 `@SpringBootTest` + `@ActiveProfiles("test")`

**测试数据库**：
- 默认 H2 内存库（`MODE=PostgreSQL` 兼容模式），Flyway 在 test profile 下禁用
- 配置见 `src/test/resources/application-test.yml`

**WireMock**：
- Stub 位置：`src/test/resources/mock/mappings/`
- 响应体位置：`__files/`
- 用于模拟外部 HTTP 服务

**ArchUnit**：
- 验收 Domain 层零框架依赖
- 验收层间依赖方向（interfaces → application → domain ← infrastructure）
- 依赖：`archunit-junit5`

**测试数据**：
- XLSX 测试文件 → `src/test/resources/`
- 配置文件 → `application-test.yml`

## 日志规范

**SLF4J + Logback**：
```java
private static final Logger log = LoggerFactory.getLogger(MyClass.class);
log.info("Processing order {}", orderId);  // 参数化，不拼接字符串
```

**级别配置**：domain=DEBUG, infrastructure=INFO, framework=WARN

**禁止**：
1. `System.out.println` / `System.err.println`
2. 日志中输出密码、Token、身份证号等敏感数据
3. 保留仅为调试目的添加的日志（任务完成后清理）

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：
```
feat(domain): 新增 Xxx 值对象
fix(infra): 修复 N+1 查询问题
refactor(app): 重构 XxxService
test(domain): 补充 DomainRuleEngine 测试
docs: 更新 AGENTS.md
chore: 升级依赖版本
```

提交粒度：每个独立子任务至少一个 commit；修复审查反馈时 commit message 引用审查报告问题编号。

## Flyway 迁移

- 脚本命名：`V{version}__{description}.sql`
- 脚本位置：`src/main/resources/db/migration/`
- DB 状态字段用 SMALLINT，Domain 层映射为 Java 枚举

## Spring Boot 启动与配置

**启动命令**：`mvn spring-boot:run` 或 `java -jar`

**健康检查**：`/actuator/health`（需引入 actuator starter）

**配置文件分层**：
- `application.yml` — 公共配置
- `application-dev.yml` — 开发环境
- `application-prod.yml` — 生产环境
- `application-test.yml` — 测试环境

**文件上传**：`spring.servlet.multipart.max-file-size: 20MB`，Controller 层须做文件类型白名单校验

**CORS**：开发环境允许前端跨域
