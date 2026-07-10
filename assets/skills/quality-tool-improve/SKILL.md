---
name: quality-tool-improve
description: 工具规则改进指南。Phase 3 reviewer 加载，用于将识别的可工具化 pattern 转化为具体的 ArchUnit / PMD / Spotless / SonarQube 规则草案，写入 issue 的 suggestion 字段。fixer 按 issue 中的规则草案直接实施，无需加载本 skill。
---

## 适用范围

本 skill 仅供 **Phase 3 的 reviewer** 加载。当 reviewer 在审查中发现一个 pattern 问题可以/应该通过工具自动检测时，加载本 skill 获取规则编写模板，将具体的规则草案写入 issue 的 `suggestion` 字段。

**不适用场景**：
- fixer 不加载本 skill——fixer 按 issue 中的 `suggestion` 直接实施
- Phase 2 的 developer 和 validator 不加载本 skill
- Phase 1 的 architect 不加载本 skill

## 识别可工具化 pattern

以下信号表明一个问题可能可以工具化：

| 信号 | 示例 | 对应工具 |
|------|------|---------|
| 包/层依赖违规 | domain 层 import Spring 注解 | ArchUnit |
| 特定注解/命名模式违规 | 类级别 @SuppressWarnings | ArchUnit 或 PMD |
| 特定方法签名模式违规 | domain 实体暴露 public setter | ArchUnit |
| 代码结构/复杂度违规 | 方法超 100 行 | PMD |
| 格式化违规 | 缩进/换行不符合团队约定 | Spotless |
| 安全漏洞模式 | SQL 拼接、硬编码凭证 | SonarQube |

## 规则草案模板

### ArchUnit 规则

在 issue 的 `suggestion` 中提供以下内容：

```java
// 规则文件位置：src/test/java/{package}/architecture/
// 规则名称：{描述性名称}
// 严重级别：{对应 issue severity}

@Test
void {testMethodName}() {
    classes()
        .that().{条件}
        .should().{约束}
        .check(classes);
}

// 示例：domain.model 包下的实体不应暴露 setId/setCreatedAt/setUpdatedAt 等 public setter
@Test
void domainEntitiesShouldNotExposePublicSetters() {
    classes()
        .that().resideInAPackage("..domain.model..")
        .should(new ArchCondition<JavaClass>("not have public setters") {
            @Override
            public void check(JavaClass javaClass, ConditionEvents events) {
                for (JavaMethod method : javaClass.getMethods()) {
                    if (method.getName().matches("setId|setCreatedAt|setUpdatedAt|setDeletedAt")
                        && Modifier.isPublic(method.getModifiers())) {
                        events.add(SimpleConditionEvent.violated(method,
                            "domain entity " + javaClass.getName() + " should not expose " + method.getName()));
                    }
                }
            }
        })
        .check(classes);
}
```

- 规则文件放在 `src/test/java/cn/com/ey/fso/loanreview/architecture/` 下
- 文件名：`{Domain}{Concern}ArchRuleTest.java`（如 `DomainEntityEncapsulationArchRuleTest.java`）
- 验证命令：`mvn test -Dtest="*ArchRuleTest"`

### PMD 规则

在 issue 的 `suggestion` 中提供以下内容：

```xml
<!-- 规则文件位置：src/main/resources/pmd-rules.xml -->
<!-- 在 <ruleset> 中追加以下规则 -->

<rule name="{规则名}"
      language="java"
      message="{违规信息}"
      class="{PMD 规则类名}"
      priority="{1-5，1=最高}">
    <description>{规则描述}</description>
    <priority>{1-5}</priority>
    <properties>
        <property name="xpath" value="{XPath 表达式}" />
    </properties>
</rule>
```

- PMD 规则文件位置：`src/main/resources/pmd-rules.xml`
- 新增规则追加在 `<ruleset>` 元素内
- 验证命令：`mvn pmd:check`

对于简单模式，推荐使用 XPath 规则；复杂逻辑使用 Java 规则类（需放在独立模块中）。

### Spotless 规则

Spotless 使用 Palantir Java Format，自定义空间有限。多数格式问题通过更新 pom.xml 中的 `spotless-maven-plugin` 配置实现：

- 规则位置：`pom.xml` → `spotless-maven-plugin` 配置块
- 验证命令：`mvn spotless:check`
- 自动修复：`mvn spotless:apply`

### SonarQube 规则

项目使用 SonarQube 内置质量配置（规则 6,500+），一般无需自定义规则。如需调整：

- 在 SonarQube UI 中创建自定义质量配置并导出 `quality-profile.xml`
- reviewer 在 issue 中注明需调整的规则 ID（如 `java:S106`）和新优先级
- 验证命令：`sonar-scanner`

## 规则与 severity 映射

| 来源 | 级别 | issue severity |
|------|------|---------------|
| ArchUnit 违规 | — | Medium |
| PMD priority 1 | — | High |
| PMD priority 2 | — | Medium |
| PMD priority 3 | — | Low |
| SonarQube blocker | — | Critical |
| SonarQube critical | — | High |
| SonarQube major | — | Medium |
| SonarQube minor | — | Low |
| Spotless 违规 | — | Low |

## 输出要求

reviewer 识别可工具化 pattern 后，在 issue 中：
1. `description`：描述问题（与常规 issue 一致）
2. `suggestion`：包含规则草案 + 文件位置 + 验证命令（按上述模板）
3. 可在 issue 末尾标注 `[tool_eligible]` 便于 fixer 识别
