# 单任务初建与统一语义写入验收

日期：2026-11-22。版本：插件 0.4.0、协议 3、数据库 schema 3。运行时：Windows、Node.js 24.15.0。

工程检查通过。真实桌面菜单触发、真实 Agent 完整阅读和语义质量仍待验收。

## 当前流程

```text
显式 code-map-init → 索引器解析事实、生成任务文件
                              │
                Agent 用宿主工具读取全部纳入源码
                              │
                    一份层级语义 JSON
                              │
手动补丁 / Stop 结果 ──→ annotate --apply → 统一校验与租约事务 → SQLite
```

- 用户调用即授权初建，不再二次确认。预览只读，普通查询不隐式建图。
- 初建结果按 Cluster、文件、重要节点组织，只引用索引器 ID，不重写物理事实。
- 初建、手动补丁和 Stop 结果共用写入器，保留原 base、范围、指纹、幂等、事务与逐对象语义基线规则。
- 初建结果上限 16 MiB，增量操作数组上限 64 KiB。失败保留未发布事实；恢复后更换任务及 base。
- `physical_revision` 管理物理快照，`semantic_revision` 管理接受的语义变更。与 Git commit 无关。

## 实测结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | 48/48 |
| `npm run test:lifecycle` | 8/8 |
| `npm run test:hooks` | 9/9，事件重放与模拟宿主适配器 |
| `npm run test:mcp` | 9/9，实际 stdio 协议 |
| `npm run validate:plugin` | 51/51 |
| 初建 Skill 静态校验 | 通过 |

新测试覆盖：完整归属、漏文件、重复文件、未知引用、跨文件节点、严格 JSON、重要对象缺少语义、注释来源、超过旧补丁上限的单份结果、文件与 stdin 重放、失败回滚、任务更新后拒绝旧结果，以及 Git commit 前的源码同步。

schema 1／2 升级前生成 SQLite 备份。schema 2 的两个修订值保持不变；旧物理字段改名，旧初建批次表移除，旧待执行工作单标为已取代。旧格式 base 被拒绝。测试确认备份可读且升级后库完整性正常。

## 验证边界

初建测试使用固定语义夹具，不能替代真实 Agent 阅读和语义质量验收。文件覆盖校验只能证明完整归属。真实桌面完整初建、实际宿主隔离维护、性能门槛和 Agent Token 对照未在本轮重测。已有维护验收边界见 [维护验收记录](index-maintenance-acceptance.md)。
