# Security Policy

## Supported version

仅维护当前默认分支的最新版本。发现问题后，请先在最新版本复现。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下提交，不要创建公开 Issue。

报告建议包含：

- 受影响的文件、接口和版本
- 最小复现步骤与实际影响
- 是否涉及房间令牌、聊天内容、插件执行或第三方账号凭据
- 建议修复方式（如有）

请勿在报告中粘贴真实 `.env`、`NCM_COOKIE`、插件管理令牌、用户聊天内容或仍然有效的房间身份令牌。

## Security boundaries

- 房间身份令牌必须只通过 HTTPS/WSS 或微信云托管内部通道传输。
- 生产环境必须为插件导入配置 `PLUGIN_IMPORT_TOKEN`。
- MusicFree 插件运行器使用 `node:vm` 限制常见能力，但它不是硬安全边界；只允许可信插件。
- 房间状态保存在进程内。多副本部署需要外部共享状态和消息广播支持，当前版本不得直接扩为多副本。
