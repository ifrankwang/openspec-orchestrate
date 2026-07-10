---
name: java-api-conventions
description: Java 后端接口层规范——Controller 写法、RESTful 路径、参数校验、Swagger 注解、统一返回 R<T>、异常响应体系（领域异常类 + GlobalExceptionHandler + HTTP 状态码映射 + 业务错误码）。适用场景：编写 Controller 或 DTO（backend-developer）、接口层规范审查（code-reviewer）、异常处理实现。当新增 REST 接口、设计异常类、或实现统一响应包装时使用。
---

## Controller 层规范

| # | 规则 | 说明 |
|---|------|------|
| 1 | 必须用 `@RestController` | |
| 2 | 路径统一 `/loan-review/api/v1/` 前缀 + kebab-case | 如 `/loan-review/api/v1/review-tasks/{taskId}/loans`；前缀通过 `server.servlet.context-path=/loan-review` + Controller 映射 `/api/v1/...` 组合实现 |
| 3 | RESTful 风格 | 禁止 POST 包打天下；GET 查询、POST 创建、PUT/PATCH 更新、DELETE 删除 |
| 4 | Controller 仅做参数校验 + 调用 application 层 | 不写业务逻辑，业务逻辑在 application/domain service |
| 5 | `@Validated` + `jakarta.validation` 校验参数 | 注解加在 DTO 字段上，入口触发校验 |
| 6 | 前端 String 字段加长度 + 特殊字符控制 | InfoSec 合规要求，用 `@Size`/`@Pattern` |
| 7 | 统一返回 `R<T>` | 除文件下载等特殊场景外 |
| 8 | 文件上传接口 Controller 层校验 MIME 类型 | 仅允许 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`（XLSX） |

## Swagger 注解

引入 SpringDoc OpenAPI（`springdoc-openapi-starter-webmvc-ui`，适配 Spring Boot 4）后，接口与 DTO 必须补充注解：

| 对象 | 注解 |
|------|------|
| Controller 类 | `@Tag(name = "xxx相关接口")` |
| 接口方法 | `@Operation(summary = "xxx")` |
| DTO 字段 | `@Schema(description = "xxx")` |

## 统一返回 R<T>

所有接口统一返回 `R<T>` 包装，成功用 `R.success(data)`，失败携带业务错误码与消息。结构约定：

- `code`：业务错误码（数字），成功时为 0 或约定成功值
- `message`：错误描述，支持 `{}` 动态占位参数
- `data`：业务数据泛型

## 异常响应体系

**不引入** `ServiceExceptionUtil` + 查表式 `ResultCode` 数字体系。采用领域异常类 + 全局处理器映射方案，更符合 DDD。

### 领域异常类

领域异常类统一放在 `domain/exception` 包（零框架依赖），application/infrastructure/interfaces 层通过抛出这些异常来触发 GlobalExceptionHandler 映射。异常类携带业务错误码：

```
DesensitizeException     — 脱敏处理失败
ExternalQueryException   — 外部信息查询失败
XlsxParseException       — Excel 解析失败
AiGenerationException    — LLM 生成失败
NotFoundException        — 资源未找到
ConflictException        — 状态冲突
InvalidFileTypeException — 文件类型不合法
```

异常类构造时关联数字业务错误码（集中定义在 ErrorCode 常量类中，按域分段），错误消息支持 `{}` 占位并在抛出时传参。

### GlobalExceptionHandler 映射

`@RestControllerAdvice` 全局处理器按异常类型返回标准 HTTP 状态码：

| 异常类型 | HTTP 状态码 | 含义 |
|---------|------------|------|
| `NotFoundException` | 404 | 资源不存在 |
| `ConflictException` | 409 | 状态冲突（如重复提交） |
| `InvalidFileTypeException` | 415 | 不支持的媒体类型 |
| 参数校验失败 | 400 | `@Validated` 触发 |
| `XlsxParseException` | 500 | 服务端解析失败 |
| `AiGenerationException` | 500 | 服务端 AI 生成失败 |
| `DesensitizeException` | 500 | 脱敏处理失败 |
| `ExternalQueryException` | 500 | 外部信息查询失败 |
| 其他未捕获异常 | 500 | 兜底 |

业务错误码作为 `R<T>` 响应体中独立数字字段，与 HTTP 状态码解耦：HTTP 码供客户端/网关判断大类，业务错误码供前端精确分支处理。
