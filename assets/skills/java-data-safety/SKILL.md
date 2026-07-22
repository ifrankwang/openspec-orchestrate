---
name: java-data-safety
description: 仅限 Java 后端开发场景。数据访问与外部集成安全规范——MyBatisPlus、POI、LangChain4j、文件上传、凭证管理。适用场景：Phase 3 安全审查（code-reviewer-security）、Phase 3 性能审查（code-reviewer-performance）、Phase 2 编写代码（backend-developer）。
---

## MyBatisPlus 数据安全

**参数绑定（防 SQL 注入）**：
```java
// 正确：参数绑定
@Select("SELECT * FROM {table_name} WHERE id = #{id}")
LoanInfoPO selectById(@Param("id") Long id);

// 错误：字符串拼接（SQL 注入风险！）
// @Select("SELECT * FROM {table_name} WHERE id = " + id)
```

**审查要点**：所有 SQL 必须使用 `#{param}` 形式，严禁 `+` 字符串拼接。

**PO ↔ Domain 转换**：使用 MapStruct Converter（按项目 MapStruct 规范）

**DB 状态字段**：DB 用 SMALLINT → Domain 映射为枚举 → MyBatisPlus TypeHandler 自动转换

**N+1 防范**：列表查询后循环内逐条查详情是典型 N+1，应用批量查询或 JOIN 替代

## Apache POI

**大文件流式读取**：
```java
// 正确：SXSSFWorkbook 流式读取
SXSSFWorkbook wb = new SXSSFWorkbook(new XSSFWorkbook(inputStream), 100);

// 错误：直接用 XSSFWorkbook 加载全量数据（OOM 风险）
// XSSFWorkbook wb = new XSSFWorkbook(inputStream);
```

**测试底稿**：`src/test/resources/` 下存放测试用 XLSX

**导出**：XSSFComment 添加线程批注；XSSFCellStyle 设置红色高亮

## LangChain4j

**配置**：
```yaml
langchain4j:
  open-ai:
    base-url: ${LLM_BASE_URL}
    api-key: ${LLM_API_KEY}
    chat-model:
      model-name: {LLM_MODEL_NAME}
      timeout: 120s
      log-requests: false    # 生产环境必须 false（客户数据泄露风险）
      log-responses: false
```

**关键规则**：
- API Key 从环境变量读取，禁止任何形式的硬编码
- 生产环境 `log-requests` 和 `log-responses` 必须为 false
- 调用必须有超时配置（>0，默认 120s）
- 循环内调用 LLM 必须异步或有超时保护
- 自动化测试仅断言响应结构，不断言内容（LLM 输出非确定性）

## 凭证管理

- API Key / Token / 密码 从环境变量或外部配置中心读取
- 不得在代码、配置文件、注释中硬编码
- docker-compose 中的密码与 application-*.yml 中的密码必须一致
- .env 文件不得提交（加入 .gitignore）

## 文件上传安全

- `spring.servlet.multipart.max-file-size` 限制文件大小
- Controller 层必须校验 MIME 类型（仅允许 xlsx）
- 上传接口对外暴露时必须有鉴权

## 日志脱敏

- 禁止在日志中输出：密码、Token、身份证号、手机号、银行卡号
- 生产环境 LangChain4j `log-requests` / `log-responses` 必须为 false
- 使用参数化日志（`log.info("{}", value)`），避免意外拼接敏感数据

## 外部调用超时与重试

- 所有 HTTP/LLM/消息队列调用必须有超时配置
- 超时时间应合理（LLM 建议 60-120s，HTTP 建议 10-30s）
- 无超时配置 → High 级别问题
- 循环内同步外部调用 → High 级别问题
