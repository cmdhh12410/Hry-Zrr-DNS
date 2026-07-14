# Tasks

- [x] Task 1: 修复种子数据中的管理员密码哈希
  - [x] 更新 `migrations/0002_seed.sql` 使用 `bcryptjs` 生成正确的 `admin123` 哈希
  - [x] 验证：执行 `node -e "const bcrypt=require('bcryptjs');bcrypt.hash('admin123',10).then(h=>console.log(h))"` 生成哈希并替换

- [x] Task 2: 创建环境检查脚本 `scripts/check-env.sh`
  - [x] 检查 Node.js 版本 >= 18
  - [x] 检查 npm 可用
  - [x] 检查 wrangler 已安装
  - [x] 检查 wrangler 已登录（wrangler whoami）
  - [x] 输出友好的错误提示和安装指引

- [x] Task 3: 创建资源创建脚本 `scripts/setup-resources.sh`
  - [x] 创建 D1 数据库 `dns-db`（检测已存在则跳过）
  - [x] 创建 KV 命名空间 `KV`（检测已存在则跳过）
  - [x] 自动解析 wrangler 输出，提取 database_id 和 kv_id
  - [x] 自动更新 `wrangler.toml` 中的 ID 占位符

- [x] Task 4: 创建数据库初始化脚本 `scripts/init-db.sh`
  - [x] 执行 `migrations/0001_initial.sql`（含 --remote 标志）
  - [x] 执行 `migrations/0002_seed.sql`（含 --remote 标志）
  - [x] 错误处理：SQL 执行失败时输出错误并退出

- [x] Task 5: 创建部署验证脚本 `scripts/verify-deploy.sh`
  - [x] 从 wrangler.toml 或部署输出提取 Worker URL
  - [x] 请求 `/health` 端点验证 200
  - [x] 请求 `/api/auth/login` 验证管理员登录成功
  - [x] 输出验证结果摘要

- [x] Task 6: 创建一键部署脚本 `deploy.sh`（Linux/macOS）
  - [x] 按顺序调用：check-env → setup-resources → npm install → init-db → 配置 JWT 密钥 → wrangler deploy → verify-deploy
  - [x] 每步有明确的状态输出（绿色 ✓ / 红色 ✗）
  - [x] 任何步骤失败时停止并输出错误信息
  - [x] 自动生成 JWT_SECRET（64位随机字符串）
  - [x] 自动保存 JWT_SECRET 到本地 `.env` 文件
  - [x] 部署成功后输出管理员账号信息和 Worker URL

- [x] Task 7: 创建一键部署脚本 `deploy.ps1`（Windows PowerShell）
  - [x] 与 `deploy.sh` 功能完全一致，使用 PowerShell 语法
  - [x] 每步有明确的状态输出（绿色 ✓ / 红色 ✗）
  - [x] 任何步骤失败时停止并输出错误信息

# Task Dependencies
- Task 2, Task 3, Task 4, Task 5 相互独立，可并行开发
- Task 6 依赖 Task 2, Task 3, Task 4, Task 5
- Task 7 依赖 Task 6（功能逻辑一致，只是语法转换）
- Task 1 独立，优先完成