# Code Map

面向 Coding Agent 的代码导航插件。按 Cluster、文件、重点节点逐级查看语义。已知路径或 ID 时直接定位，按需追踪静态路径。

支持 TypeScript／JavaScript 与 Python，优先验收 Windows。v0.4 使用 v3 协议：默认查询自动刷新已启用索引；`PostToolUse` 提前同步已识别的源码写入；`Stop` 登记完整语义工作单。默认不阻塞主回合。后台隔离维护需要宿主接入适配器；当前真实桌面与 Agent 验收仍待完成，见 [维护验收记录](docs/index-maintenance-acceptance.md)。请审核并信任 Hook 定义。Hook 不可用时仍可手动维护。

首次建图从桌面 `/` 菜单选择 `code-map-init`，或显式调用 `$code-map:code-map-init`。Agent 用宿主工具读取全部纳入源码，一次提交语义 JSON；无需二次确认。

用 `use-code-map` Skill 选择所需的 CLI 查询。默认安装包只注册两个 Skill 与生命周期 Hook。

| 查询 | 粒度 |
|---|---|
| `map_overview` | Cluster 作用与成员文件，或按相对目录浏览文件结构 |
| `map_browse_files` | 批量返回文件用途、内容和重点节点职责 |
| `map_inspect_node` | 单项或批量返回节点定义和直接关系 |
| `map_trace_node_paths` | 从节点出发的静态多跳路径与逐边证据 |

## 构建与测试

需要 Node.js 24.15.0 或更高版本。Git 跟踪源码和锁文件；依赖、编译输出、本地插件包和工作区索引留在本机。

```bash
npm ci --ignore-scripts        # 从锁文件安装，不运行原生 grammar 安装脚本
npm run build                  # 编译 CLI、Hook 与开发用 stdio server，复制 WASM
npm test                       # 单元 + 集成（先自动 build）
npm run test:mcp               # 真实 stdio MCP：initialize/tools.list/tools.call
npm run test:lifecycle         # 状态机、增量 sync、annotate prepare/apply
npm run test:hooks             # Hook 与宿主适配器事件重放
npm run typecheck              # 全量类型检查
npm run validate:plugin        # 清单、路径边界、Hook、Skill 与 marketplace 校验
npm run pack:plugin            # 组装 plugins/code-map/ 并生成 zip 与 SHA256SUMS
npm run bench:agent -- <目录>  # 汇总真实成对任务记录，检查发布门槛
```

## 命令行

发布入口为 `dist/cli.mjs`（打包后为 `plugins/code-map/dist/cli.mjs`）。业务 JSON 输出到 stdout，日志到 stderr。退出码：0 成功、2 参数或协议错误、3 状态不允许或发布条件未满足、4 基础设施错误、5 锁或版本冲突。

```bash
node dist/cli.mjs init     --root <path> [--dry-run]
node dist/cli.mjs sync     --root <path> [--resume|--rebuild]
node dist/cli.mjs annotate --root <path> [--prepare [--scope ID]|--apply --base BASE --input F]
node dist/cli.mjs suspend  --root <path>
node dist/cli.mjs doctor   --root <path>
node dist/cli.mjs query    <name> --root <path> [--input F]
```

## 本地安装

`npm run pack:plugin` 生成自包含的 `plugins/code-map/` 与 `dist/code-map-<版本>.zip`，内含供 Codex 发现 Hook 的兼容清单。仓库根 `.agents/plugins/marketplace.json` 以 `./plugins/code-map` 为本地来源。在桌面端刷新或重启后安装，审核并信任 Hook，再开启新会话验证 `use-code-map` 和 `code-map-init`。从 v0.1 升级时，移除另行配置的 Code Map MCP 服务器，以免其工具继续进入模型上下文。

从源码独立测试 stdio MCP 时，使用 `node dist/server.mjs`。

## 文档

- [设计方案](docs/design.md)：初建 JSON、数据模型、查询和增量维护协议。
- [实施方案](docs/implementation-plan.md)：实施顺序、文件职责、验证命令、验收与发布。
- [M1 验收记录](docs/m1-acceptance.md)：工程测试、性能数据与待验收项。
- [M2 验收记录](docs/m2-acceptance.md)：Hook 编排、打包与待实测项。
- [单任务初建验收](docs/initial-build-acceptance.md)：统一写入、物理版本改名与迁移测试。
- [依据与核实记录](docs/evidence.md)：原始需求、官方规范、依赖与当前验证边界。
- [用户反馈](feedback.md)：原始反馈，保留不变。

## 首次建图与语义维护

查询返回 `physical_index: {status: "valid", physical_revision}`、`semantic_revision` 和提交引用 `base`。对象的 `semantics.status` 为 `reviewed`、`needs_review`、`missing` 或 `not_selected`。物理索引有效不代表旧语义已复核。

```text
默认查询 / apply_patch Hook / Stop → sync → 当前事实
已接受语义基线 + 当前事实 → 完整工作单
维护 Agent / 手动调用者 → 操作数组 + 原 base → annotate → 逐对象推进基线
```

`init` 返回初建任务文件和原 `base`。Agent 只输出 Cluster、文件和重点节点的归属、重要性与说明，按 `clusters → files → highlights` 组织；普通文件只需 ID。一次通过 `annotate --apply` 提交，初建结果上限 16 MiB，成功后事实和语义一并发布。未提交到 Git 的源码修改同样参与索引同步。

`annotate --prepare` 返回完整待办，可用 `--scope ID` 读取指定对象。`annotate --apply --base BASE --input -` 接收 UTF-8 操作数组；文件输入使用相同格式和 64 KiB 上限。操作为 `cluster`、`file`、`node`、`keep`。普通文件不要求用途；选中重要文件或节点时必须同时提供语义。详见 [v3 协议](skills/use-code-map/references/protocol.md)。

数据库 schema 1／2 在启用工作区首次写入或查询时升级到 schema 3，升级前保留 SQLite 备份；旧物理版本值保持不变，字段统一为 `physical_revision`。旧文件用途不自动成为重要性选择。默认后台入口不可用时保留待办。只有用户明确选择后，才在 `.codemap/state.json` 设置 `maintenance_mode: "main"` 使用一次主 Agent 续跑。
