---
name: java-db-conventions
description: 仅限 Java 后端开发场景。数据库规范——PostgreSQL 表结构约定、审计字段、逻辑删除、索引命名、操作人来源、MyBatisPlus 持久化用法、Flyway 迁移。适用场景：Phase 2 编写 PO/Mapper/迁移脚本（backend-developer）、Phase 3 DB 规范审查（code-reviewer）、Phase 1 设计表结构。当新增表、编写 Mapper、或修改 Flyway 脚本时使用。
---

## 表结构规范

| 项 | 约定 | 示例 |
|----|------|------|
| 数据库 | PostgreSQL | TIMESTAMPTZ / JSONB / gen_random_uuid() |
| 表名前缀 | `{project_prefix}_` + 业务域名 | `{project_prefix}_order`、`{project_prefix}_order_item` |
| 主键 | UUID，`DEFAULT gen_random_uuid()` | `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| 状态字段 | DB 层 SMALLINT，实体层映射为枚举 | `status SMALLINT DEFAULT 0` |
| JSONB 字段 | 用具体 Java 类型 + typeHandler，建 GIN 索引 | `attributes JSONB` |

## 审计字段

所有表必须包含以下审计字段：

```sql
created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
creator     VARCHAR(64)  NOT NULL DEFAULT '',
updater     VARCHAR(64)  NOT NULL DEFAULT '',
deleted_at  TIMESTAMPTZ  DEFAULT NULL
```

- `created_at` / `updated_at`：创建/更新时间
- `creator` / `updater`：操作人标识，来源见下方「操作人来源」
- `deleted_at`：逻辑删除时间，NULL = 未删除

## 逻辑删除

采用 `deleted_at TIMESTAMPTZ DEFAULT NULL`（PostgreSQL 风格），配合**部分唯一索引**约束未删除行的唯一性：

```sql
-- 仅对未删除行建立唯一约束，已删除行不受限
CREATE UNIQUE INDEX uk_{table}_{column} ON {project_prefix}_{table} (business_key) WHERE deleted_at IS NULL;
```

部分唯一索引方案（`WHERE deleted_at IS NULL`）比 `deleted` 字段存主键值的大而全方案更自然、语义更清晰，是 PostgreSQL 原生推荐的逻辑删除唯一约束方式。

## 索引命名

| 类型 | 前缀 | 示例 |
|------|------|------|
| 唯一索引 | `uk_` | `uk_order_code` |
| 普通索引 | `idx_` | `idx_order_item_order` |
| 部分唯一索引 | `uk_` + `WHERE deleted_at IS NULL` | 见上方逻辑删除 |

索引名字段部分使用 snake_case（与 PG 列名一致），不使用 camelCase。

## 操作人来源

典型鉴权框架模式：后端驱动 OAuth2/OIDC 授权码登录并签发标准 JWT，操作人标识从 JWT 还原：

- JWT 过滤器（`OncePerRequestFilter`）校验 JWT 并将身份写入 SecurityContext
- 拦截器从 SecurityContext 取操作人标识写入请求级鉴权上下文
- 持久化层从鉴权上下文取标识填充 `creator`/`updater` 审计字段

具体实现（如 Azure AD、Keycloak 等 IDP）按项目技术栈选择。

## MyBatisPlus 持久化用法

| 项 | 约定 |
|----|------|
| Mapper 包路径 | `{basePackage}.infrastructure.persistence`（由 `@MapperScan` 显式指定） |
| Mapper 注解 | 建议标注 `@Mapper` |
| PO 基类 | infrastructure 层定义 PO 基类统一审计字段，PO 继承之（注意：domain 实体按 DDD 包结构约定，独立于 PO，不继承该基类） |
| 查询方式 | 优先 `LambdaQueryWrapper` 面向对象方法；仅复杂多表关联/方言特性/Wrapper 难以表达时才写 XML SQL |
| 避免 | `select *`，防止映射不稳定 |
| Mapper XML | 语句间保持空行提升可读性 |
| 枚举映射 | 实体枚举字段用 `@EnumValue` 映射 DB SMALLINT |
| JSONB 映射 | 用具体 Java 类型 + typeHandler（需验证 MyBatisPlus 对 PG JSONB 适配，可能需自定义 typeHandler） |

使用 MyBatisPlus 标准 `BaseMapper` + `LambdaQueryWrapper`，不依赖第三方增强框架的自研 Wrapper。

## 审计字段自动填充

`creator`/`updater` 由 MyBatisPlus `MetaObjectHandler` 自动填充，业务代码不手动设值：

- PO 审计字段标注：`creator` 用 `@TableField(fill = FieldFill.INSERT)`，`updater` 用 `@TableField(fill = FieldFill.INSERT_UPDATE)`
- 实现 `MetaObjectHandler`，在 `insertFill`/`updateFill` 中从鉴权上下文取操作人标识注入
- 鉴权上下文由拦截器从 SecurityContext（JWT 还原的身份）提取操作人标识，请求级作用域
- `created_at`/`updated_at` 同理用 `MetaObjectHandler` 填充，或依赖 DB `DEFAULT now()` / `ON UPDATE`
- domain 实体不含审计字段，无 MyBatisPlus 注解（零框架依赖）；自动填充仅作用于 infrastructure 层 PO

## Flyway 迁移

- 脚本命名：`V{version}__{description}.sql`（如 `V1__init_schema.sql`）
- 脚本位置：`src/main/resources/db/migration/`
- 表结构变更由 Flyway 版本化管理，迁移脚本即变更记录，不另建 SQL 变更目录
- test profile 下 Flyway 禁用，测试用 H2（`MODE=PostgreSQL`）
