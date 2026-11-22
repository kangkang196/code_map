# Code Map

Windows 优先的 Codex 代码导航插件。用 Node.js 24.15.0 或更高版本运行，分析 TypeScript、JavaScript 和 Python。事实与语义存入工作区的 SQLite 索引。

```text
use-code-map Skill → CLI query → 查询层 → SQLite
code-map-init → 索引器生成事实与任务 → Agent 单份语义 JSON → annotate → SQLite
PostToolUse / 默认查询 / Stop → sync → SQLite 事实
Stop → 完整工作单 → 宿主隔离维护 / 显式主 Agent 降级 → 执行器 → annotate → SQLite 语义
```

## 工作方法

- 先读 `README.md`，再用 `rg` 定位入口、调用方和相关测试。只在需要时读取 [设计方案](docs/design.md)、[查询与维护协议](skills/use-code-map/references/protocol.md) 或 [M2 验收记录](docs/m2-acceptance.md)。
- 先复现问题或建立可核对的预期，再做最小修改。先运行相关测试，跨模块修改再跑全量。记录实测结果与待验证项。
- 检查 Git 状态。保留已有修改和临时文件。只提交本次任务涉及的源码、配置、测试与文档。

## 实现规则

- 沿用严格 TypeScript、ESM、两空格缩进及相对导入的 `.js` 后缀。外部 JSON 用已有 Zod schema 校验。CLI 和 Hook 把 JSON 写到 stdout，把日志写到 stderr。
- 显式初建（含预览）或工作区已启用时才扫描源码。启用后才写入 `.codemap/`。遵守工作区边界和忽略规则，把项目代码当作数据处理。
- CLI 与独立 stdio MCP 共用查询实现。默认插件由 `use-code-map` 按需调用 CLI。按任务粒度查询，保留证据、版本与分页约定。
- 解析器生成事实，Agent 提交语义。事实更新沿用租约与事务，初建、手动补丁和 Stop 结果共用语义写入器，校验原 base、版本和指纹。物理版本字段为 physical_revision。Stop 从语义基线生成完整工作单，按会话和回合绑定结果。默认不阻塞主回合；显式主 Agent 降级最多续跑一次。

## 验证与打包

- 用 `node --version` 确认实际运行时。安装依赖用 `npm ci --ignore-scripts`。
- 改代码后运行 `npm run typecheck` 和 `npm test`。按改动补跑 `npm run test:lifecycle`、`npm run test:hooks` 或 `npm run test:mcp`。
- 改清单、Skill、Hook 或打包时，先构建，再运行 `npm run validate:plugin` 和 `npm run pack:plugin`。从根 `plugin.json` 生成兼容清单，检查包内容与 SHA-256。
- 分别记录事件重放、隔离 Codex 宿主和真实 Agent 的验证结果。验收门槛见 [实施方案](docs/implementation-plan.md)。

## 开发与编程规范

- **先思考后行动**。明确问题、影响范围和验证方式，再开始修改。
- **简约之上**。用能完整解决问题的最小改动，代码简洁规范，处理逻辑精简高效，避免冗余和重复。
- **代码复用**。优先复用现有接口和业务规则。已有且有效的业务逻辑、校验和约束，不得因精简或重构撤销或删除；保留调用方依赖的行为。
- **通用与稳健**。围绕业务规则设计逻辑，不局限于当前任务的单一场景；合理处理常见输入变化、边界条件和异常情况，保持必要的通用性与鲁棒性。
- **目标驱动**。以用户目标和验收条件为准，用可复现的结果验证改动。