# 索引维护 v2 验收记录

日期：2026-11-21。版本：v0.3.0。Node：Windows x64 24.15.0。

## 实现范围

- CLI 与独立 stdio MCP 共用完整源码校验与一次自动同步。verify 模式只校验。
- schema 2 保存已接受基线、独立文件重要性和完整工作单。升级前保留原 SQLite 备份。
- 查询分别返回物理有效状态与语义状态。普通文件可不提供语义，也可包含重要节点。
- 手动、主 Agent 降级与后台路径共用操作数组、原 base、64 KiB 输入限制和租约事务。
- Stop 默认只做有时限的本地同步与任务登记。无宿主时保留待办，不阻塞、不自动降级。
- use-code-map 替代 navigate。包只注册 PostToolUse（apply_patch）和 Stop。

```text
源码变动 → 默认查询 / PostToolUse / Stop → 事实同步
已接受基线 + 当前事实 → 完整工作单
主回合完成 → 宿主适配器 → 只读分支 → JSON → 执行器 → annotate
```

## 本次验证

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 47 项通过 |
| `npm run test:lifecycle` | 8 项通过 |
| `npm run test:hooks` | 9 项通过；包含宿主接口事件重放 |
| `npm run test:mcp` | 9 项通过；真实 stdio initialize／list／call |
| `npm run validate:plugin` | 51 项通过；兼容 LF／CRLF |
| `npm run pack:plugin` | 通过；生成本地插件目录、ZIP 和校验和 |
| 包内容与 CLI 检查 | ZIP 与本地包的 1,107 个文件校验和均通过；与当前源码及编译输出一致；打包 CLI 检查通过 |

共 73 项测试。归档为 `dist/code-map-0.3.0.zip`，归档 SHA-256 保存在同名 `.sha256` 文件；包内逐文件清单为 `SHA256SUMS.txt`。已核对 ZIP、本地插件目录和当前编译输出；旧 navigate 与 SessionStart 入口未进入包。

覆盖：自动刷新、忽略与暂停、锁冲突、过期分页、解析覆盖、普通文件发布、纯位置移动、AST 与自动分号插入、变更撤销、跨会话差异重建、删除证据、部分基线推进、UTF-8 stdin／文件重放、重要性升降级、错误工作区、版本冲突、完整工作单、重复 Stop、普通聊天、可空返回、统一执行器、只读 fork、完成事件早于 start 响应、目标能力缺失、原基线恢复、执行超限和自动范围限制。

## 宿主接入边界

`src/semantic/host.ts` 提供 MaintenanceAdapter 和 MaintenanceHost 接口。拥有源 thread 的宿主把既有 request／subscribe 连接接入适配器，并提供需禁用的写入插件 ID。Hook 本身没有该连接，也不会启动独立 Agent 服务。标准插件安装只登记任务；当前未把适配器接入真实桌面宿主。

适配器在源 turn/completed 后校验 sessionId，再 fork 指定 lastTurnId 的 ephemeral、excludeTurns 只读分支。分支禁用 Hook，清除继承目标并执行工具回合。父目标活动时，宿主必须实现 forkWithDeferredGoal 的原子延迟能力；缺少能力即保留 pending。该接口不向 App Server 发送未支持的参数。

本机 Codex 生成的 App Server schema 确认 fork 字段、完成事件、只读 sandbox 和目标接口；当前 fork schema 未提供父目标延迟字段。官方来源：[App Server](https://learn.chatgpt.com/docs/app-server)、[Hook 输入与工具覆盖](https://learn.chatgpt.com/docs/hooks)。代码核对和事件重放不等于真实桌面或实际模型验收。

PostToolUse 按官方的 `tool_input.command` 读取规范化 apply_patch 输入，提取 Add／Update／Delete／Move 路径，再以实际清单差异决定是否同步。

## 待验收

- 真实桌面：主回合先结束、下一回合可开始、后台工具循环、指定历史、源码及 Skill 可读、写入插件禁用、父目标不续跑、超限取消、退出恢复和维护记录隔离。
- 显式 main 降级：真实客户端的续跑回合标识和 last_assistant_message 绑定。当前严格按已登记会话与回合接收，不猜测普通新回合的来源。
- 真实 Agent：语义质量、跨会话任务和成对任务效果；未运行。
- v2 的 A／B 规模性能与 Token 门槛；未复测。旧 M2 数字仅代表历史版本。

上述门槛完成前，不宣称默认后台语义维护已在真实桌面可用。
