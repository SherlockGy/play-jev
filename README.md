# play-jev

Jev 与 TypeSafe 的应用实验，各个演示保存在独立子目录。

- [2048 · Jev 决策实验室](2048-jev/README.md)：Node.js 调度 Jev 选择方向，通过 Playwright MCP 在可见的 Chrome 标签页操作真实游戏。
- [TypeSafe skill](.agents/skills/typesafe-ai/SKILL.md)：本项目使用的开发指导，保留上游许可证。

进入 `2048-jev` 后运行 `npm ci`、`npm test`、`npm start`。需要 Node.js 22 或更新版本、Chrome 官方 Playwright 扩展，以及用户环境变量中的 `TYPESAFE_API_KEY`。详细配置和 Windows 迁移方法见子项目说明。

密钥、依赖、运行记录和本机调试产物不纳入版本控制。
