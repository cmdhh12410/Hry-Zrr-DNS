# Checklist

- [x] 种子数据管理员密码哈希使用 bcryptjs 正确生成，`admin123` 可登录
- [x] 环境检查脚本正确检测 Node.js >= 18、npm、wrangler、wrangler 登录状态
- [x] 资源创建脚本正确创建 D1 和 KV，自动更新 wrangler.toml 中的 ID
- [x] 资源创建脚本检测已存在资源时跳过创建，不报错
- [x] 数据库初始化脚本正确执行两个 SQL 迁移文件
- [x] 数据库初始化失败时输出错误信息并退出
- [x] 部署验证脚本正确请求 `/health` 和 `/api/auth/login`
- [x] 部署验证脚本在服务不可用时正确处理超时和重试
- [x] `deploy.sh` 脚本在 Linux/macOS 环境下可执行
- [x] `deploy.sh` 脚本每个步骤有明确的状态输出
- [x] `deploy.sh` 脚本任一步骤失败时停止并输出错误
- [x] `deploy.sh` 脚本自动生成 JWT_SECRET 并保存到 `.env`
- [x] `deploy.sh` 脚本部署成功后输出管理员账号和 Worker URL
- [x] `deploy.ps1` 脚本在 Windows PowerShell 环境下可执行
- [x] `deploy.ps1` 脚本功能与 `deploy.sh` 完全一致
- [x] 所有脚本文件添加可执行权限（Unix）或正确编码（Windows）
- [x] `.gitignore` 已包含 `.env` 文件，确保不会提交密钥