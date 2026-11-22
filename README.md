# EndlessPixel 服务状态数据

[EndlessPixel 站点](https://www.endlesspixel.cn)的可用性探测数据，用于 `/status` 页面的历史可用率与时间线。

## 为什么单独一个仓库

进度数据每小时生成一条，一年不到九千条。放在主站仓库里的话：

- 每小时一次提交会触发一次 Vercel 构建，纯属浪费；
- 探测历史与业务代码混在一起，`git log` 会被数据提交淹没。

单独一个公开仓库最省事：不需要数据库、不需要跨仓库令牌，数据本身也天然可审计。

## 数据格式

`data/YYYY-MM.json`，按月一个文件，只保留最近 3 个月。

```json
{
  "version": 1,
  "month": "2026-11",
  "checks": [
    { "t": "2026-11-22T10:07:00.000Z", "r": { "web": [1, 230], "mc": [1, 1800] } }
  ]
}
```

`r` 里每个服务是 `[是否成功(0/1), 耗时毫秒]`。某个服务没有出现，表示当次未配置地址、被跳过（不记为故障）。

服务键：`web`（网站）、`mc`（Minecraft 服务器）、`ai`（AI 对话服务）、`rankings`（模型排行数据源）、`monitor`（服务器性能监控）。

## 探测方式

`.github/workflows/check.yml` 每小时第 7 分钟跑一次 `scripts/check.mjs`：

| 服务 | 探测地址 | 判定 |
|---|---|---|
| `web` | 站点首页 | HTTP 2xx |
| `mc` | mcsrvstat 接口 | 响应体里 `online === true` |
| `ai` | `${STATUS_API_BASE_URL}/ping` | HTTP 2xx |
| `rankings` | `${STATUS_API_BASE_URL}/api/rankings?period=today` | HTTP 2xx |
| `monitor` | `${STATUS_TARGET_API_URL}/api/data` | HTTP 2xx |

单个请求 15 秒超时，任一失败不影响其它服务。

## 需要配置的 Secrets

| Secret | 用途 |
|---|---|
| `STATUS_API_BASE_URL` | 上游代理出口（AI 对话与模型排行共用） |
| `STATUS_TARGET_API_URL` | 宿主机性能监控上游 |

不配置也不会报错，只是对应服务不参与探测。想改探测目标，编辑 `scripts/check.mjs` 里的 `SERVICES`。
