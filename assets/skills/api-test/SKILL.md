---
name: api-test
description: Web 应用 API 自动化测试——编写 HTTP 黑盒测试脚本与前置 SQL 数据脚本。技术栈无关，仅绑定 Web 应用。适用场景：Phase 3 任务验证中编写/补充 API 测试脚本（task-verifier）。
---

## 目录结构

API 测试素材独立于项目源代码目录（不放入 src/test/ 等构建工具测试源码目录），避免与单元测试混淆。

```
<project-root>/api-tests/
  ├── data/        # SQL 前置数据脚本（按场景准备数据库数据）
  └── script/      # API 测试脚本
```

reviewer 可据项目现有目录惯例微调位置，但必须与构建工具的测试源码目录隔离。

## 脚本格式

API 测试脚本使用 shell 脚本 + curl + jq。每个场景一个脚本文件。

```sh
#!/bin/bash
set -euo pipefail

# 项目根 URL：从项目配置的 context-path 读取
BASE="http://localhost:8080"

# 获取认证 Token：检查项目 dev profile 是否有免登入口
# 常见模式：dev-only login endpoint / static test token / basic auth
# 从项目 application 配置或 docker-compose 环境变量中查找
# TOKEN=$(curl -s "$BASE/api/v1/local/login" | jq -r '.token')
# AUTH="Authorization: Bearer $TOKEN"

# 正常路径
echo "=== 正常路径：创建资源 ==="
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -X POST "$BASE/api/v1/engagements" \
  -d '{"name": "测试项目"}' | jq .

# 关键边界：缺必填字段
echo "=== 边界：缺必填字段 ==="
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -X POST "$BASE/api/v1/engagements" \
  -d '{}' | jq '.code, .message'

# 关键边界：非法值
echo "=== 边界：非法值 ==="
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -X POST "$BASE/api/v1/engagements" \
  -d '{"name": ""}' | jq '.code, .message'
```

## SQL 前置数据脚本

SQL 脚本按场景准备无法通过接口构造的数据库数据（历史数据状态、多表联动前置条件）。要求幂等：

- PostgreSQL: `INSERT INTO ... ON CONFLICT DO NOTHING`
- MySQL: `INSERT IGNORE INTO ...`
- H2: `MERGE INTO ...` 或 `INSERT ... ON CONFLICT DO NOTHING`

按项目实际 DB 类型选择写法。

## 认证发现

API 测试脚本运行前 reviewer 需获取有效认证凭证。常见模式：

1. **Dev-only login 端点**：检查项目配置中是否有 profile 专属的免登入口（如 local/dev profile 下的登录 API）
2. **静态 Token**：检查项目是否有 dev profile 专属的 JWT 密钥配置，可用相同密钥签发测试 token
3. **Basic Auth**：检查 spring security / 项目配置中 dev profile 是否有固定凭证
4. **无认证**：若 dev profile 完全关闭认证，无需 token

reviewer 从项目 application 配置文件和 SecurityConfig 中查找。

## 执行顺序

```
1. SQL 数据脚本 → 2. 启动服务 → 3. API 测试脚本 → 4. 停止服务
```

- SQL 在前：先准备数据，再启动应用确保应用启动时读取到完整数据
- 启动服务：按项目构建文件确定的启动方式（mvn / gradle / npm 等）
- API 脚本：依赖运行中的服务
- 停止服务：测试完成后清理

## 覆盖要求

API 测试脚本必须覆盖所有新增/变更接口：

| 维度 | 覆盖内容 |
|------|---------|
| 正常路径 | 按 spec 请求结构传入合法值，验证响应状态码(2xx) 和响应结构 |
| 关键边界 | 缺必填字段 → 4xx；非法值(空串/超长/类型错误) → 4xx；极值 → 正确响应或合理错误 |
