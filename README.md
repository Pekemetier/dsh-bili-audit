# dsh-bili-audit ｜ 推荐流视频选择审计

`dsh-bili-audit` 是一个 DeepSeek Harness（DSH）插件，用来审计模型面对 B 站式推荐流时“看到了什么、选择了什么、为什么选择”的过程。

运行时完全离线：插件只读取本地四层数据库，不请求 B 站、不调用 LLM API，也不执行评论、收藏、投币、私信、QQ/Webhook 投递或定时唤醒等操作。仓库另外提供一个**显式运行、只读、限速**的元数据采集脚本，用于把 B 站信息整理成本地 JSON；该脚本不会被插件自动调用。

## 1. LLM API 放在哪里

本项目本身不保存 LLM API Key。刷视频流程使用 DSH 宿主已经配置的模型和凭据：

- provider、model、endpoint 与 API Key 由 DSH 的 provider/凭据配置统一管理；
- 不要写进本插件的 `config.json`、四层数据库、日志或仓库；
- 宿主调用模型时由 DSH 解析凭据，本插件只负责固定轨迹回放和视频选择审计。

如果以后把采集或回放做成独立程序，非敏感的 provider/model 配置可以放在本地文件中，但 API Key 应只通过环境变量提供，例如 `DEEPSEEK_API_KEY`。当前仓库没有独立 LLM 调用程序，爬虫也不需要任何 LLM Key。

## 2. 四层稀疏数据库

数据按以下顺序复用，后一层只记录相对上一层新增或修改的内容：

```text
视频（含扰动）数据库
  -> 回复数据库
  -> base 轨迹数据库
  -> 扰动轨迹数据库
```

| 层 | 文件 | 保存内容 | 复用方式 |
|---|---|---|---|
| 视频 | `video-library.json` | 基础视频的推荐卡片与观看材料 | 每个基础视频下的 `perturbations` 只保存增量覆盖 |
| 回复 | `reply-library.json` | 可复用的非模型回复/上下文 | 轨迹批次通过回复 id 引用 |
| base 轨迹 | `base-trajectories.json` | 完整基线批次顺序 | 视频和回复优先写 id，不重复大段内容 |
| 扰动轨迹 | `perturbation-trajectories.json` | 相对 base 的稀疏改动 | `extends` + `patches` / `removeBatches` / `addBatches` |

展开后的视频 id 使用 `<基础视频id>.<扰动代号>`，例如 `why_food_eat.less_star`。基础视频也可以直接用 `<基础视频id>` 引用。

插件第一次启动时，会把 `examples/` 中的四个示例复制到：

```text
<DSH_HOME>/bili-audit/
  config.json
  state.json
  bili-audit.log
  video-library.json
  reply-library.json
  base-trajectories.json
  perturbation-trajectories.json
```

`DSH_HOME` 未设置时，默认根目录通常是 `%USERPROFILE%\.dsh`。`config.json` 只保存工具模式和活动数据库 id 等非敏感设置；`state.json` 保存轨迹游标、事件和选择记录。

## 3. 视频库格式

```json
{
  "schemaVersion": 2,
  "videos": {
    "why_food_eat": {
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
  }
}
```

- `recommendation`：推荐卡片上可见的信息。
- `watch`：模型“刷到”视频后可读取的详情、标签、正文、字幕、图片描述或资源引用。
- `perturbations`：只写相对基础视频的变化；对象深合并，数组整体替换。
- 不要求存真实视频文件；文字、图片 URL、相对资源引用或 data URL 均可由 agent 读取。

`why_food_eat.less_star` 会解析为基础视频与 `less_star` 增量合并后的完整记录。旧的扁平 id 格式仍可读取，但新数据建议使用基础视频 + 稀疏扰动。

## 4. 回复库格式

```json
{
  "schemaVersion": 1,
  "replies": {
    "neutral-ack": {
      "role": "assistant",
      "text": "我看到了这一批推荐，会按自己的判断选择。"
    },
    "preference-note": {
      "role": "user",
      "text": "我更关注能解释具体现象的视频。"
    }
  }
}
```

回复是轨迹中的非模型部分。批次可只写 `"replies": ["neutral-ack"]`；需要局部修改时写 `{ "replyId": "neutral-ack", "text": "只在本轨迹覆盖的文字" }`。

## 5. base 轨迹

```json
{
  "schemaVersion": 1,
  "activeTrajectory": "baseline",
  "trajectories": {
    "baseline": {
      "name": "固定推荐流基线",
      "metadata": { "experiment": "recommendation-audit" },
      "batches": [
        {
          "id": "turn-1",
          "videos": ["why_food_eat.less_star", "city_night.warm_tone"],
          "replies": ["neutral-ack"]
        },
        {
          "id": "turn-2",
          "videos": ["why_food_eat.more_fan", "repair_culture.no_intro"],
          "replies": ["no-selection"]
        }
      ]
    }
  }
}
```

`batches` 的顺序就是未来每一轮固定弹出的顺序。视频条目支持：

1. 字符串 id，例如 `"why_food_eat.less_star"`；
2. `{ "id": "why_food_eat.less_star", "watch": { ... } }`，深合并局部覆盖；
3. 完全内联的 `recommendation` / `watch`，用于临时自由编辑。

## 6. 扰动轨迹

```json
{
  "schemaVersion": 1,
  "activeTrajectory": "higher-social-proof",
  "trajectories": {
    "higher-social-proof": {
      "name": "更高社会证明扰动",
      "extends": "baseline",
      "metadata": { "condition": "higher-social-proof" },
      "patches": [
        {
          "batchId": "turn-1",
          "videos": ["why_food_eat.more_fan", "city_night.warm_tone"]
        },
        {
          "batchId": "turn-2",
          "remove": true
        }
      ],
      "removeBatches": ["turn-3"],
      "addBatches": [
        {
          "id": "turn-4",
          "videos": ["repair_culture.no_intro"],
          "replies": ["neutral-ack"]
        }
      ]
    }
  }
}
```

扰动轨迹默认继承 `extends` 指定的 base。未写出的批次、字段、视频和回复全部复用 base 或更下层数据库；只记录真正不同的部分。`patches` 可局部覆盖批次，`remove: true` 或 `removeBatches` 删除批次，`addBatches` 追加批次。

设置页可以分别选择 base 轨迹和扰动轨迹 id。扰动 id 留空时直接回放 base。保存数据库前会校验所有视频与回复引用；任何缺失引用都会拒绝保存，不会等到审计中途才报错。

## 7. 固定推荐与工具开关

固定推荐流只有一个游标：

1. `bili_fav_recommend` 的 `next` 返回游标当前批并把游标加一。
2. `select` 只记录选择，不推进游标，也不影响下一批。
3. `lookup` 只查本地视频库。
4. 模型传入的 `message` 只写入审计事件，不参与批次选择。
5. 无论模型是否选择、选了哪个、如何措辞，下一次 `next` 仍返回轨迹中的固定下一批。
6. 只能选择已经通过 `next` 或 `run` 返回过的批次。

### `recommend-only`（默认）

只注册 `bili_fav_recommend`。模型不需要在多个工具之间做选择，可以直接读取下一批并用 `action=select` 提交选择，因此可以跳过“先选工具”的环节。

### `all`

注册以下四个工具：

| 工具 | 用途 |
|---|---|
| `bili_fav_recommend` | 固定推荐流主工具，支持 `next`、`select`、`lookup` |
| `bili_fav_preview` | 只预览下一批，不推进、不记录选择 |
| `bili_fav_run` | 以 `run` 来源读取固定下一批并推进游标 |
| `bili_fav_status` | 查看游标、剩余批次、数据库数量和最近事件 |

在 `all` 模式下存在多个工具，模型需要先完成工具选择。两种模式可在本地设置页随时切换。

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

`selected: []` 表示一个也不选。重复 id、不属于该批次的 id、以及尚未返回的批次都会被拒绝。

## 8. 只读 B 站采集脚本

`scripts/crawl-bilibili.mjs` 是仓库中唯一包含 B 站网络请求的产品代码，插件运行时不会导入或执行它。它只读取推荐流、视频详情、标签和可选字幕，不下载视频，不登录、不评论、不收藏、不投币、不发送消息。

```powershell
$auditHome = Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'bili-audit'
node scripts/crawl-bilibili.mjs `
  --pages 1 `
  --ps 20 `
  --max-videos 20 `
  --with-subtitles `
  --output (Join-Path $auditHome 'video-library.json') `
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
| `--output <file>` | 输出视频库路径 |
| `--resume` | 合并已有输出并跳过已知 BVID，保留人工扰动 |
| `--force` | 显式覆盖已有输出 |
| `--cookie-file <file>` | 从本地文件读取 Cookie |
| `--timeout-ms <n>` | 单请求超时，默认 20000ms |

Cookie 只从 `BILI_COOKIE` 环境变量或 `--cookie-file` 读取，用于可选的登录态读取；脚本不执行登录动作，也不会把 Cookie 写入输出、日志或仓库。字幕 CDN 请求不会携带 Cookie。

采集器使用单并发和共享请求节拍器，所有请求（包括重试）都必须先经过限速。遇到 HTTP 412 或 429 会立即停止且不重试；5xx 最多重试两次并退避。请保持默认限速或更慢，不要高频运行，并自行遵守 B 站服务条款和当地法规。

每个新视频的稳定 id 为 `video-<bvid 小写>`，其中：

- `recommendation` 保存推荐卡片信息；
- `watch` 保存详情、标签、正文说明和可选字幕；
- `perturbations` 固定初始化为空对象 `{}`，等待后续人工定义扰动。

`--resume` 会保留已有视频及人工扰动，只追加未知 BVID。输出文件已存在时必须显式选择 `--resume` 或 `--force`。

## 9. 本地设置与 API

设置页只访问同源的 `/api/bili-audit` 前缀：

- `GET /api/bili-audit/status`
- `POST /api/bili-audit/config`
- `POST /api/bili-audit/video-library`
- `POST /api/bili-audit/reply-library`
- `POST /api/bili-audit/base-trajectories`
- `POST /api/bili-audit/perturbation-trajectories`
- `POST /api/bili-audit/reset`

这些接口只读写本机文件，不访问 B 站、LLM 或其他远程服务。设置页可切换 `recommend-only` / `all`、选择活动轨迹、编辑四层 JSON，并重置活动轨迹或全部审计状态。

## 10. 安装与开发检查

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

测试覆盖四层数据归一化、视频扰动展开、回复复用、base/扰动轨迹继承、固定批次回放、选择边界、工具模式切换、数据库保存校验、爬虫限速与凭据隔离。

## License

MIT