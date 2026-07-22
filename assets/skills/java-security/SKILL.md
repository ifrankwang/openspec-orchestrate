---
name: java-security
description: Java 后端安全实现规范（security-baseline 的 Java 配套）。MyBatisPlus 注入防护、POI OOM 防范、LangChain4j 安全配置、Spring 安全配置、SLF4J 日志脱敏。适用场景：Phase 3 安全审查（code-reviewer-security）、Phase 2 编写代码（backend-developer）。
---

> 本文是 security-baseline 的 Java 实现配套。通用原则见 security-baseline，本文仅补充 Java / Spring 技术栈特有的实现细节。

## MyBatisPlus 数据安全

**参数绑定（防 SQL 注入）**：
```java
@Select("SELECT * FROM {table_name} WHERE id = #{id}")
LoanInfoPO selectById(@Param("id") Long id);
```

XML Mapper 和注解 SQL 必须使用 `#{param}` 形式，严禁 `+` 字符串拼接。`${}` 仅可用于表名列名等不可参数化的位置，且值须白名单校验。

**PO ↔ Domain 转换**：使用 MapStruct Converter（按项目 MapStruct 规范）

**DB 状态字段**：DB 用 SMALLINT → Domain 映射为枚举 → MyBatisPlus TypeHandler 自动转换，禁止业务代码直接判断数值

**N+1 防范**：列表查询用 MyBatis collection/association 嵌套映射或手动批量查询，拒绝循环内逐条查

## Apache POI

**大文件流式读取**：
```java
SXSSFWorkbook wb = new SXSSFWorkbook(new XSSFWorkbook(inputStream), 100);
```

禁止直接用 `XSSFWorkbook` 加载全量数据（OOM 风险）。测试底稿放 `src/test/resources/`。导出使用 `XSSFComment` 添加批注、`XSSFCellStyle` 设置样式。

## LangChain4j

- API Key 从环境变量读取，禁止硬编码
- 生产环境 `log-requests` 和 `log-responses` 必须为 false
- 调用必须有超时配置（>0，默认 120s）
- 循环内调用 LLM 必须异步或有超时保护
- 自动化测试仅断言响应结构，不断言内容

## Spring 安全配置

**文件上传**：
- `spring.servlet.multipart.max-file-size` 限制文件大小，值按项目实际业务需求配置
- Controller 层校验 MIME / Content-Type，按项目实际允许类型做白名单，不准使用与项目无关的硬编码
- 上传接口对外暴露时必须有鉴权

**跨环境凭证一致性**：
- docker-compose 中的密码与 application-*.yml 中的密码必须一致
- `.env` 不得提交仓库

## SLF4J 日志脱敏

- 使用参数化日志：`log.info("{} {}", user.getId(), action)`，禁止字符串拼接
- 生产环境 LangChain4j `log-requests` / `log-responses` 必须为 false

## 外部调用超时（Spring HTTP 客户端）

- RestTemplate：通过 `SimpleClientHttpRequestFactory` 设 connectTimeout / readTimeout
- WebClient：通过 `HttpClient.responseTimeout()` / `.option()` 设超时
- Spring Cloud OpenFeign：`feign.client.config.<service>.connect-timeout` / `read-timeout`
- 所有超时值 > 0，普通 HTTP 建议 10-30s
- 循环内同步 HTTP 调用 → High 级别问题
