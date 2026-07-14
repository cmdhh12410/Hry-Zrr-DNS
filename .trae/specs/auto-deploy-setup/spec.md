# 自动化部署脚本 Spec

## Why
用户需要一个一键式的自动化部署脚本，将 DNS 分发系统完整部署到 Cloudflare Workers，包括环境检查、资源创建、数据库初始化、密钥配置和部署验证，确保整个流程不会报错。

## What Changes
- 新增 `deploy.sh` 一键部署脚本（Linux/macOS/WSL）
- 新增 `deploy.ps1` 一键部署脚本（Windows PowerShell）
- 新增 `scripts/check-env.sh` 环境检查脚本
- 新增 `scripts/setup-resources.sh` Cloudflare 资源创建脚本
- 新增 `scripts/init-db.sh` 数据库初始化脚本
- 新增 `scripts/verify-deploy.sh` 部署验证脚本
- **BREAKING**: 无

## Impact
- Affected specs: 无现有 specs
- Affected code: `wrangler.toml`（需支持占位符自动替换）、部署脚本

## ADDED Requirements

### Requirement: 一键部署
系统 SHALL 提供一个 `deploy.sh` (Linux/macOS) 和 `deploy.ps1` (Windows) 脚本，用户只需执行该脚本即可完成全流程部署。

#### Scenario: 首次部署成功
- **WHEN** 用户在项目根目录执行 `deploy.sh`（或 `deploy.ps1`）
- **AND** 用户已安装 Node.js 18+、npm、wrangler
- **AND** 用户已通过 `wrangler login` 登录 Cloudflare
- **THEN** 脚本自动完成：环境检查 → 安装依赖 → 创建 D1 → 创建 KV → 更新 wrangler.toml → 初始化数据库 → 配置 JWT 密钥 → 部署 Worker → 验证部署
- **AND** 输出部署成功信息和 Worker URL

#### Scenario: 环境不满足要求
- **WHEN** 用户执行部署脚本
- **AND** Node.js 版本低于 18 或未安装 wrangler
- **THEN** 脚本输出明确的错误提示和安装指引，退出

#### Scenario: 未登录 Cloudflare
- **WHEN** 用户执行部署脚本
- **AND** 用户未通过 `wrangler login` 认证
- **THEN** 脚本提示用户先执行 `wrangler login`，然后退出

### Requirement: 环境检查
系统 SHALL 在部署前检查所有必要环境依赖。

#### Scenario: 检查通过
- **WHEN** 脚本执行环境检查
- **AND** Node.js >= 18, npm 可用, wrangler 已安装且已登录
- **THEN** 环境检查通过，继续下一步

#### Scenario: 检查失败
- **WHEN** 脚本执行环境检查
- **AND** 缺少任一依赖
- **THEN** 输出明确的错误信息，指出缺少哪个依赖及如何安装

### Requirement: 自动创建 Cloudflare 资源
系统 SHALL 自动创建 D1 数据库和 KV 命名空间。

#### Scenario: 资源创建成功
- **WHEN** 脚本执行资源创建
- **THEN** 创建 D1 数据库 `dns-db`
- **AND** 创建 KV 命名空间 `KV`
- **AND** 自动将返回的 ID 写入 `wrangler.toml`

#### Scenario: 资源已存在
- **WHEN** 脚本尝试创建已存在的资源
- **THEN** 检测到已存在，跳过创建，使用现有资源的 ID

### Requirement: 自动初始化数据库
系统 SHALL 自动执行数据库 Schema 创建和种子数据导入。

#### Scenario: 数据库初始化成功
- **WHEN** 脚本执行数据库初始化
- **THEN** 执行 `migrations/0001_initial.sql` 创建所有表
- **AND** 执行 `migrations/0002_seed.sql` 导入种子数据
- **AND** 自动修正管理员密码哈希为正确的 bcrypt 值

#### Scenario: 数据库初始化失败
- **WHEN** 脚本执行数据库初始化
- **AND** SQL 执行出错
- **THEN** 输出错误详情，退出

### Requirement: 自动配置密钥
系统 SHALL 自动生成安全的 JWT 密钥并配置到 Cloudflare。

#### Scenario: 密钥配置成功
- **WHEN** 脚本执行密钥配置
- **THEN** 自动生成 64 位随机 JWT 密钥
- **AND** 通过 `wrangler secret put` 设置到 Cloudflare
- **AND** 将密钥保存到本地 `.env` 文件（不提交到 git）

### Requirement: 部署验证
系统 SHALL 在部署完成后自动验证服务是否正常运行。

#### Scenario: 验证成功
- **WHEN** 脚本执行部署验证
- **THEN** 请求 `/health` 端点确认返回 200
- **AND** 请求 `/api/auth/login` 确认管理员可登录
- **AND** 输出验证通过信息

#### Scenario: 验证失败
- **WHEN** 脚本执行部署验证
- **AND** 健康检查或登录失败
- **THEN** 输出错误信息，提示用户检查日志

### Requirement: 修复种子数据密码哈希
种子数据中的管理员密码使用预生成的 bcrypt 哈希，但需要确保与 `bcryptjs` 库兼容。脚本 SHALL 在部署时自动修正。

#### Scenario: 密码哈希修正
- **WHEN** 脚本执行数据库初始化
- **THEN** 使用 `bcryptjs` 生成正确的 `admin123` 哈希
- **AND** 通过 SQL UPDATE 更新数据库中的管理员密码哈希