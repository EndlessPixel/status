#!/usr/bin/env node
/**
 * 服务可用性探测 —— 由 GitHub Actions 每小时运行一次。
 *
 * 结果按小时追加到 data/YYYY-MM.json，网站读取这些文件算出可用率与历史时间线。
 * 之所以不建数据库：一小时一条、一年不到九千条，JSON 足够，
 * 而且放公开仓库意味着数据本身也是可审计的。
 *
 * 数据格式（刻意做紧凑，月度文件里会有 700+ 条）：
 *   { "version": 1, "month": "2026-11", "checks": [ { "t": ISO时间, "r": { "web": [1, 230] } } ] }
 *   r 里每个服务是 [是否成功(0/1), 耗时毫秒]
 */

import fs from "node:fs/promises";
import path from "node:path";

/** 需要凭据的地址由 Actions secrets 注入；未配置的服务会被跳过，不记为故障 */
const API_BASE_URL = (process.env.STATUS_API_BASE_URL || "").replace(/\/+$/, "");
const TARGET_API_URL = (process.env.STATUS_TARGET_API_URL || "").replace(/\/+$/, "");
const SITE_URL = (process.env.STATUS_SITE_URL || "https://www.endlesspixel.cn").replace(/\/+$/, "");

const OUT_DIR = path.join(process.cwd(), "data");
/** 只保留最近 N 个月，避免仓库无限膨胀 */
const KEEP_MONTHS = 3;
/** 单个请求超时：整轮探测要在 Actions 的几分钟预算内跑完 */
const TIMEOUT_MS = 15000;

/**
 * 探测目标。key 必须与网站侧 `lib/status-history.ts` 的映射一致。
 * `url()` 返回空字符串表示「没有配置地址」，此时跳过该服务。
 */
const SERVICES = [
  {
    key: "web",
    name: "网站",
    url: () => SITE_URL,
  },
  {
    key: "mc",
    name: "Minecraft 服务器",
    url: () => "https://api.mcsrvstat.us/3/epmc.qzz.io",
    // 接口本身 200 不代表服务器在线，要看 online 字段
    judge: (json) => json?.online === true,
  },
  {
    key: "ai",
    name: "AI 对话服务",
    url: () => (API_BASE_URL ? `${API_BASE_URL}/ping` : ""),
  },
  {
    key: "rankings",
    name: "模型排行数据源",
    url: () => (API_BASE_URL ? `${API_BASE_URL}/api/rankings?period=today` : ""),
  },
  {
    key: "monitor",
    name: "服务器性能监控",
    url: () => (TARGET_API_URL ? `${TARGET_API_URL}/api/data` : ""),
  },
];

/** 探测单个服务，返回 [ok, latencyMs]；跳过时返回 null */
async function probe(service) {
  const url = service.url();
  if (!url) return null;

  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "EndlessPixel-StatusBot/1.0 (+https://www.endlesspixel.cn/status)",
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
      },
    });
    const latency = Date.now() - startedAt;

    if (!res.ok) {
      await res.body?.cancel();
      return [0, latency];
    }

    if (service.judge) {
      const json = await res.json().catch(() => null);
      return [service.judge(json) ? 1 : 0, latency];
    }

    // 正文用不上（排行榜一次几十 KB），拿到状态码就够了
    await res.body?.cancel();
    return [1, latency];
  } catch {
    return [0, Date.now() - startedAt];
  }
}

/** 本地时区无意义，统一用 UTC 月份分文件 */
function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const now = new Date();
  const month = monthKey(now);
  await fs.mkdir(OUT_DIR, { recursive: true });

  const entries = await Promise.all(
    SERVICES.map(async (service) => {
      const result = await probe(service);
      return [service.key, result];
    }),
  );

  /** 只保留真的探测过的服务 */
  const results = {};
  for (const [key, value] of entries) {
    if (value) results[key] = value;
  }

  if (Object.keys(results).length === 0) {
    console.error("所有服务都没有可探测的地址，请检查 secrets 配置");
    process.exit(1);
  }

  const file = path.join(OUT_DIR, `${month}.json`);
  let data = { version: 1, month, checks: [] };
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(data.checks)) data.checks = [];
  } catch {
    // 文件不存在 = 本月第一条，用上面的空结构
  }

  data.checks.push({ t: now.toISOString(), r: results });
  // 按时间排序，避免手动补跑导致顺序错乱
  data.checks.sort((a, b) => a.t.localeCompare(b.t));

  await fs.writeFile(file, `${JSON.stringify(data)}\n`, "utf8");

  const summary = Object.entries(results)
    .map(([key, [ok, ms]]) => `${key}=${ok ? "up" : "DOWN"}(${ms}ms)`)
    .join(" ");
  console.log(`${now.toISOString()} ${summary} → ${file}`);

  // 清理过期月份
  const files = (await fs.readdir(OUT_DIR)).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
  const stale = files.slice(0, Math.max(0, files.length - KEEP_MONTHS));
  for (const name of stale) {
    await fs.unlink(path.join(OUT_DIR, name));
    console.log(`清理过期数据: ${name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
