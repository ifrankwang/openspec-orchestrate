---
name: java-ddd-architecture
description: 仅限 Java 后端开发场景。DDD 四层架构规范——包结构、层间依赖、各层职责、DTO CQRS 命名、DI 模式、值对象、Port/Adapter。适用场景：Phase 3 架构审查（code-reviewer-architecture）、Phase 1 架构师复核（architect）、Phase 2 编写代码（backend-developer）。当新增 Controller/Service/Repository/PO、调整包结构、或审查层间依赖时使用。
---

## 包结构

```
cn.com.ey.fso.loanreview
├── domain
│   ├── model        ← 聚合根、实体、值对象（纯 POJO，零框架依赖）
│   ├── service      ← Domain Service 接口 + 实现（核心领域逻辑）
│   ├── repository   ← Repository 接口（不含实现）
│   └── exception    ← 领域异常类 + ErrorCode 常量（零框架依赖）
├── application
│   ├── command      ← 写操作命令对象
│   ├── query        ← 读操作查询对象
│   ├── service      ← Application Service（编排用例，不含技术实现）
│   └── dto          ← 应用层 DTO（模块间传输）
├── infrastructure
│   ├── persistence  ← PO、Mapper、Converter（MapStruct）
│   ├── llm          ← LangChain4j 适配器
│   ├── excel        ← POI 解析器/写入器
│   ├── auth         ← AzureADClient Bean 封装（AAD 授权码登录）
│   ├── desensitize  ← Presidio 脱敏适配器
│   ├── external     ← 企查查/企业预警通外部查询适配器
│   ├── queue        ← pgmq 适配器
│   └── config       ← Spring 配置 Bean
└── interfaces
    ├── controller   ← REST Controller（仅参数校验 + 调用 application）
    ├── security     ← 登录接口 / JWT 过滤器 / SecurityConfig
    ├── dto          ← 接口层 DTO（入参/出参）
    └── assembler    ← DTO ↔ Domain 转换（MapStruct）
```

## 层间依赖

```
interfaces → application → domain ← infrastructure
```

箭头方向即依赖方向：interfaces 依赖 application，application 依赖 domain，infrastructure 依赖 domain（实现 domain 定义的 Port/Repository 接口）。infrastructure 不依赖 interfaces，interfaces 不直接依赖 infrastructure。

## 各层职责

| 层 | 职责 | 禁止 |
|----|------|------|
| interfaces | 参数校验、调用 application、DTO 转换 | 写业务逻辑、直接访问 infrastructure/domain 实体 |
| application | 编排业务用例、事务边界、协调 domain service | 技术实现细节（SQL、HTTP、LLM 调用） |
| domain | 核心领域逻辑、聚合根行为、领域服务 | 任何框架依赖（Spring/MyBatis/LangChain4j） |
| infrastructure | 技术实现：持久化、外部集成、消息队列 | 业务规则判断 |

## DTO 命名约定（CQRS 风格）

不引入 QO/VO/DTO 三分法，按包职责区分对象用途：

| 包 | 用途 | 示例 |
|----|------|------|
| `interfaces/dto` | Controller 入参/出参 | `LoanReviewResponse`、`ReviewTaskCreateRequest` |
| `application/command` | 写操作命令 | `StartReviewCommand` |
| `application/query` | 读操作查询 | `LoanListQuery` |
| `application/dto` | 应用层模块间传输 | `LoanSummaryDto` |

枚举字段直接用 Java Enum 类型，禁止用 Integer/String 作编码载体再手动转换。

## 核心规则

| # | 规则 | 违反后果 |
|---|------|---------|
| 1 | Domain 层零框架依赖（不 import Spring、MyBatis、LangChain4j、infrastructure、interfaces 的任何类） | ArchUnit 编译/测试失败 |
| 2 | 依赖方向不可逆（infrastructure 不得依赖 interfaces） | 循环依赖、架构腐化 |
| 3 | Interface 层不直接依赖 Infrastructure 层 | 架构违规 |
| 4 | 依赖注入使用构造器注入，禁止 `@Autowired`/`@Resource` 字段注入 | 测试困难、隐式依赖 |
| 5 | 值对象使用 `final` 字段，无 setter | 可变状态 bug |
| 6 | 枚举类型统一在 Domain 层定义 | 层级混乱 |
| 7 | 每个包必须有 `package-info.java` | 包文档缺失 |
| 8 | Domain 实体为纯 POJO，不继承任何框架基类（如 MyBatisPlus 的 BaseEntity） | 破坏零框架依赖约束 |
| 9 | interfaces 层不直接暴露 domain 实体，须经 assembler 转为 DTO | 层级泄露、API 契约与内部模型耦合 |
| 10 | 领域异常类（BusinessException 及其子类、ErrorCode）统一放在 `domain/exception` 包 | 异常分散在各层导致循环依赖、层级混乱 |

## Port / Adapter 模式

Domain 层定义 Port 接口（纯业务契约），Infrastructure 层实现 Adapter：

```java
// domain/service/AuGenerationPort.java — 零框架依赖
public interface AuGenerationPort {
    AuOpinion generate(LoanDataCard dataCard);
}

// infrastructure/llm/LangChain4jAuGenAdapter.java — 实现
@Component
public class LangChain4jAuGenAdapter implements AuGenerationPort {
    // 内部使用 LangChain4j @AiService
}
```

## 共性能力基础设施化

应统一拦截/封装到 Infrastructure 层或框架级能力的横向逻辑，不得分散在各 Controller/Service 中逐点调用。

### 适用场景

| 类别 | 示例 | 上收方式 |
|------|------|---------|
| 横切关注点 | 鉴权·审计·日志·限流·幂等·事务 | Filter / Interceptor / AOP（@Around/@Before/@After） |
| 共性策略约束（全局） | 文件类型·大小限制、权限规则、脱敏规则 | 先判是否全局（跨多接口/模块），若是 → 放入 Infrastructure 层统一 Filter 或 @ControllerAdvice；若是单模块 → 控制在 Application Service 门面 |
| 重复集成封装 | 外部 API 调用、序列化/转换、连接管理 | 公共 Client/Adapter 基类，一次封装全局复用 |
| 散落的全局配置 | 超时·重试·线程池·白名单 | 统一在 application.yml / @ConfigurationProperties 集中管理 |

### 判据

同一逻辑在 ≥2 处独立实现、属横向共性需求（非单点业务上下文特有）、新增场景漏调度即失效 → 必须基础设施化。

## MapStruct

```java
@Mapper(componentModel = "spring")
public interface LoanInfoConverter {
    LoanInfo toDomain(LoanInfoPO po);
    LoanInfoPO toPO(LoanInfo domain);
}
```

必须 `componentModel = "spring"`；字段映射用 `@Mapping(source, target)`。

## Spring DI

```java
// 正确：构造器注入
@RestController
public class LoanController {
    private final LoanService loanService;
    public LoanController(LoanService loanService) {
        this.loanService = loanService;
    }
}

// 错误：字段注入
@Autowired private LoanService loanService;
```
