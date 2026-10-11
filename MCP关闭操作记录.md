# MCP 关闭操作记录（2026-10-11 21:24）

## 做了什么

按 `MCP开销实测报告.md` 的建议，关掉 4 个 MCP，保留 3 个。

### 关闭的（4 个）

| server | 原开销 | 关在哪 | 为什么关 |
|---|---|---|---|
| `chrome-devtools` | 6,425 | A 类连接器 | 浏览器自动化，写提示词用不上 |
| `playwright` | 4,600 | A 类连接器 | 同上 |
| `github` | 4,149 | **A + B 两处都关** | 按你的使用频率 |
| `sequential-thinking` | 1,019 | B 类全局 patch | 与模型原生 reasoning 重复 |

### 保留的（3 个）

| server | 开销 | 说明 |
|---|---|---|
| `context7` | 1,254 | 查库文档 |
| `memory` | 1,105 | 跨会话记忆 |
| `fetch` | 283 | 读网页 |

> `unreal-engine` 本来就是关着的（`disabled: true`），没动。

## 改在哪个文件

### A 类：`~/.dsh/storages/mcp_connector.json`
由 `dsh-mcp-connector` 插件管理，**界面上是「连接器」页**。
改法：把对应连接的 `enabled` 从 `true` 翻成 `false`。

### B 类：`~/.dsh/cordis.patch.yml`
改法：给对应条目加 `disabled: true`（**与 `id`/`name`/`config` 平级**，别写进 `config` 里）。

## 预期效果

工具 token：**29,638 → 约 13,445**（省约 16,193，相对原来 45%）。

工具数量：154 个 → 约 66 个。

按边际 prefill 1.72 ms/token 粗算，**每轮少读约 16,193 token ≈ 少 28 秒**。

## 怎么验证（重启 DSH 后）

开一个新会话，然后在 DSH 里让我（或你自己）读工具清单，看还剩哪些。
或者直接看这个文件的新数据：

```
~/.dsh/storages/session_projcache/sessions/<最新会话>.json
  → record.rows.contextHeaders.val.headers[最后].tools
```

**应该看不到** `mcp__chrome-devtools__*`、`mcp__playwright__*`、
`mcp__github__*`、`mcp__sequential-thinking__*`。

## 怎么回滚

备份都在（时间戳 `1791725036`）：

```bash
cp ~/.dsh/storages/mcp_connector.json.bak-1791725036 ~/.dsh/storages/mcp_connector.json
cp ~/.dsh/cordis.patch.yml.bak-1791725036 ~/.dsh/cordis.patch.yml
```

然后重启 DSH。

或者单独把某一个改回 `true` / 删掉 `disabled: true` 那行。

## ⚠️ 一个提醒

`mcp_connector.json` 是**插件在运行时读写的文件**。如果你之后在界面的
「连接器」页里做了任何操作，插件可能会**重写这个文件** —— 理论上会保留
我们的改动（我们改的就是它自己的字段），但**如果发现开关自己变回去了，
去界面里关一次就行**。

## 顺带一个安全发现

B 类里 `mcp-github` 条目的 `config.env.GITHUB_PERSONAL_ACCESS_TOKEN` 里
**硬编码了你的 GitHub PAT**（明文）。既然已经关掉这个 MCP 了，
**建议把这行 PAT 从文件里删掉**，改成从环境变量读：

```yaml
env:
  GITHUB_PERSONAL_ACCESS_TOKEN: !!js process.env.GITHUB_TOKEN
```

（`dsh-mcp-client` 的 README 里就是这么写的。）
要的话我可以帮你改。
