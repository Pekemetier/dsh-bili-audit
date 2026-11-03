# dsh-bili-audit ｜ 推荐流视频选择审计

`dsh-bili-audit` 是一个 DeepSeek Harness（DSH）插件，用来审计模型面对 B 站式推荐流时“看到了什么、选择了什么、为什么选择”的过程。它不是 B 站客户端，也不是通用收藏/评论工具；运行时只读取本地固定轨迹，并只向模型暴露选择视频所需的能力。

运行时完全离线：插件不请求 B 站、不调用 LLM API，也不执行评论、收藏、投币、私信、QQ/Webhook 投递或定时唤醒。仓库另行提供一个显式运行、只读、限速的元数据采集脚本，用来把 B 站信息整理成本地视频文件；插件不会自动导入或执行该脚本。

## 1. LLM API 放在哪里

本项目不保存 LLM API Key。刷视频流程直接使用 DSH 宿主已经配置的模型：

- provider、model、endpoint 与 API Key 由 DSH 的 provider/凭据配置统一管理；
- 不要写进本插件的 `config.json`、本地数据文件、日志或仓库；
- 宿主调用模型时自行解析凭据，本插件只负责固定轨迹回放和选择结果记录。

如果以后把回放流程做成独立程序，非敏感的 provider/model 选择可以放在本地配置中，但 API Key 应只通过环境变量提供，例如 `DEEPSEEK_API_KEY`。当前仓库没有独立 LLM 调用程序，采集脚本也不需要 LLM Key。

## 2. 数据层次

数据按下面顺序复用，后一层只保存相对上一层新增或修改的部分：

```text
视频（含扰动） -> base 轨迹 -> 扰动轨迹
```

回复与完整批次上下文高度相关，因此不再单独保存为可复用集合；每条回复直接内联在所属轨迹批次中。

本地默认目录如下：

```text
<DSH_HOME>/bili-audit/
  config.json
  state.json
  bili-audit.log
  videos/
    why_food_eat.json
    city_night.json
    repair_culture.json
  trajectories/
    baseline/
      base.json
      higher-social-proof.json
```

对应规则：

| 层次 | 路径 | 保存内容 | 复用方式 |
|---|---|---|---|
| 视频 | `videos/<base-id>.json` | 一个基础视频的推荐卡片、观看材料和扰动定义 | 每个扰动只保存相对基础视频的稀疏覆盖 |
| base 轨迹 | `trajectories/<base-id>/base.json` | 完整基线批次顺序、批次内视频选择集合和内联回复 | 视频写 id，不重复整段视频内容 |
| 扰动轨迹 | `trajectories/<base-id>/<perturbation-id>.json` | 只保存相对所属 base 的变化 | `extends` + `patches` / `removeBatches` / `addBatches` |

每个视频单独一个文件，便于逐个修改而不会碰到其它视频；每个 base 轨迹及其所有扰动轨迹位于单独子文件夹，并且 base 与每个扰动各自单独成文件，避免单个轨迹文件过长。

`DSH_HOME` 未设置时，默认根目录通常是 `%USERPROFILE%\.dsh`。`config.json` 只保存工具模式和当前轨迹 id 等非敏感设置；`state.json` 保存固定游标、事件和选择记录。

## 3. 视频文件与扰动

视频文件示例：

```json
{
  "schemaVersion": 3,
  "id": "why_food_eat",
  "bvid": "BV1xx411c7mD",
  "recommendation": {
    "title": "为什么我们越来越难好好吃一顿饭？",
    "author": "日常观察室",
    "stats": { "views": 1200, "likes": 93 },
    "cover": { "type": "image", "alt": "夜晚餐桌" }
  },
  "watch": {
    "description": "观看时可读取的内容说明。",
    "content": [{ "type": "text", "text": "视频正文或画面说明" }],
    "subtitles": ["字幕行"]
  },
  "perturbations": {
    "less_star": {
      "recommendation": {
        "stats": { "views": 10 }
      }
    }
  }
}
```

- `recommendation`：推荐卡片上可见的信息。
- `watch`：模型“刷到”视频后可读取的详情、标签、正文说明、字幕或图片引用。
- `perturbations`：只写相对基础视频的变化；对象深合并，数组整体替换。
- 不需要存真实视频文件；文字、图片 URL、相对资源引用或 data URL 都可以作为 agent 可读材料。

最终视频 id 使用 `<基础视频id>.<扰动代号>`，例如 `why_food_eat.less_star`；基础视频也可以直接使用 `why_food_eat`。同一个基础视频的所有扰动共用一个文件。

## 4. base 轨迹与扰动轨迹

base 轨迹文件示例：

```json
{
  "schemaVersion": 3,
  "id": "baseline",
  "name": "固定推荐流基线",
  "batches": [
    {
      "id": "turn-1",
      "videos": ["why_food_eat.less_star", "city_night.warm_tone"],
      "replies": [
        {
          "id": "neutral-ack",
          "role": "assistant",
          "text": "我看到了这一批推荐，会按自己的判断选择。"
        }
      ]
    },
    {
      "id": "turn-2",
      "videos": ["why_food_eat.more_fan"],
      "replies": []
    }
  ]
}
```

`batches` 的顺序就是未来固定弹出的顺序。批次可以包含视频 id、带局部覆盖的内联视频对象，或者完整的内联视频材料。`replies` 直接保存本批次所需的文字和角色。

扰动轨迹文件只继承并修改所属 base：

```json
{
  "schemaVersion": 3,
  "id": "higher-social-proof",
  "extends": "baseline",
  "name": "更高社会证明扰动",
  "patches": [
    {
      "batchId": "turn-1",
      "videos": ["why_food_eat.more_fan", "city_night.warm_tone"]
    },
    {
      "batchId": "turn-2",
      "metadata": { "condition": "higher-social-proof" }
    }
  ]
}
```

- `extends` 必须等于所在目录的 base id。
- `patches` 只修改指定批次，数组字段按整体替换。
- `removeBatches` 删除继承批次，`addBatches` 追加新批次。
- 未写出的批次、视频、回复和元数据全部从 base 继承，不在扰动文件中重复存储。

## 5. 固定推荐流不变量

固定推荐流只有一个按最终轨迹指纹隔离的游标：

1. `bili_fav_recommend` 的 `next` 返回游标当前批并把游标加一。
2. `select` 只记录选择，不推进游标，也不影响下一批。
3. `lookup` 只查本地视频材料。
4. 模型传入的 `message` 只写入审计事件，不参与批次生成。
5. 无论模型是否选择、选了哪个、如何措辞，下一次 `next` 都返回轨迹中的固定下一批。
6. 只能选择已经通过 `next` 或 `run` 返回过的批次。

因此未来弹出的所有视频由轨迹文件预先决定，而不是由模型回答或选择动态生成。

## 6. 工具模式

### `recommend-only`（默认）

只注册 `bili_fav_recommend`。模型不需要在多个工具之间做选择，可以直接读取下一批并用 `action=select` 提交选择，从而跳过工具选择环节。

### `all`

注册以下四个工具：

| 工具 | 用途 |
|---|---|
| `bili_fav_recommend` | 固定推荐流主工具，支持 `next`、`select`、`lookup` |
| `bili_fav_preview` | 只预览下一批，不推进、不记录选择 |
| `bili_fav_run` | 以 `run` 来源读取固定下一批并推进游标 |
| `bili_fav_status` | 查看游标、剩余批次数、视频数量和最近事件 |

在 `all` 模式下存在多个工具，模型需要先完成工具选择。两种模式可以在本地设置页随时切换。

选择参数示例：

```json
{
  "action": "select",
  "batchId": "turn-1",
  "selected": [
    {
      "videoId": "why_food_eat.less_star",
      "reason": "标题和摘要中的问题意识最清楚"
    }
  ]
}
```

`selected: []` 表示一个也不选。重复 id、不属于该批次的 id，以及尚未返回的批次都会被拒绝。

## 7. 只读 B 站采集脚本

`scripts/crawl-bilibili.mjs` 是仓库中唯一包含 B 站网络请求的产品代码，插件运行时不会导入或执行它。它只读取推荐流、视频详情、标签和可选字幕，不下载视频，不登录、不评论、不收藏、不投币、不发送消息。

先把插件数据目录初始化为默认目录，再运行：

```powershell
$auditHome = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'bili-audit'
node scripts/crawl-bilibili.mjs `
  --pages 1 `
  --ps 20 `
  --max-videos 20 `
  --with-subtitles `
  --output (Join-Path $auditHome 'videos') `
  --resume
```

主要参数：

| 参数 | 说明 |
|---|---|
| `--pages <n>` | 推荐流页数，1–50，默认 1 |
| `--ps <n>` | 每页条数，1–30，默认 20 |
| `--max-videos <n>` | 最多采集视频数，默认 20 |
| `--interval-ms <n>` | 请求最小间隔，默认 2000ms，硬下限 1000ms |
| `--jitter-ms <n>` | 额外随机抖动上限，默认 500ms |
| `--with-subtitles` | 尝试采集字幕；部分字幕可能要求有效登录 Cookie |
| `--subtitle-max-chars <n>` | 每视频字幕最大字符数，默认 12000 |
| `--output <dir>` | 输出视频文件夹，每个视频一个 JSON |
| `--resume` | 扫描现有视频文件，跳过已知 BVID 并保留人工扰动 |
| `--force` | 仅覆盖同名且 BVID 相同的生成文件，不删除其它人工文件 |
| `--cookie-file <file>` | 从本地文件读取 Cookie |
| `--timeout-ms <n>` | 单请求超时，默认 20000ms |

Cookie 只从 `BILI_COOKIE` 环境变量或 `--cookie-file` 读取，用于可选的登录态读取；脚本不执行登录动作，也不会把 Cookie 写入输出、日志或仓库。字幕 CDN 请求不会携带 Cookie。

采集器使用单并发和共享请求节拍器，所有请求（包括重试）都必须先经过限速。遇到 HTTP 412 或 429 会立即停止且不重试；5xx 最多重试两次并退避。请保持默认限速或更慢，不要高频运行，并自行遵守 B 站服务条款和当地法规。

每个新视频的稳定 id 为 `video-<bvid 小写>`，写入不同的 `videos/video-<bvid 小写>.json` 文件：

- `recommendation` 保存推荐卡片信息；
- `watch` 保存详情、标签、正文说明和可选字幕；
- `perturbations` 固定初始化为空对象 `{}`，等待后续人工定义扰动。

`--resume` 会保留已有视频及人工扰动，只追加未知 BVID。若同名文件已经属于另一个 BVID，脚本拒绝覆盖，即使传入 `--force`。

## 8. 本地 API

设置页只访问同源的 `/api/bili-audit` 前缀：

```text
GET  /api/bili-audit/status
POST /api/bili-audit/config
POST /api/bili-audit/reset

GET  /api/bili-audit/videos
GET  /api/bili-audit/video?id=why_food_eat
POST /api/bili-audit/video

GET  /api/bili-audit/trajectories
GET  /api/bili-audit/trajectory?baseId=baseline&mode=base
GET  /api/bili-audit/trajectory?baseId=baseline&mode=perturbation&id=higher-social-proof
POST /api/bili-audit/base-trajectory
POST /api/bili-audit/perturbation-trajectory
```

保存接口一次只接收一个文件，避免设置页整库读写：

```json
{
  "id": "why_food_eat",
  "document": { "id": "why_food_eat", "recommendation": {}, "watch": {}, "perturbations": {} }
}
```

base 与扰动轨迹保存接口分别额外要求 `baseId`，扰动轨迹还要求 `id`。写入后会重新加载当前活动轨迹；若新内容引用了不存在的视频或轨迹，接口返回错误并恢复旧文件，避免一次误保存破坏可回放的数据。

这些接口只读写本机文件，不访问 B 站、LLM 或其他远程服务。

## 9. 安装与开发检查

```bash
dsh plugin --profile web add dsh-bili-audit
```

```bash
node --check index.js
node --check client.js
node --check scripts/crawl-bilibili.mjs
npm test
npm run check
npm run pack:check
```

测试覆盖拆分视频文件、稀疏视频扰动、base/扰动轨迹继承、内联回复、固定批次回放、选择边界、工具模式切换、逐文件保存校验与回滚、爬虫限速和凭据隔离。

## License

MIT
