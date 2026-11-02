# dsh-bili-qq ｜ 推荐流选择审计

这是一个 DeepSeek Harness（DSH）离线插件，用来审计模型面对 B 站式推荐流时“看什么、选什么、为什么选”的过程。

它不访问 B 站，不登录账号，不读取 Cookie，不调用任何远程 API，也不提供评论、收藏、投币、私信、QQ 推送、定时唤醒等会改变外部状态的功能。视频、推荐卡片和观看内容全部来自本地 JSON。包名保留为 `dsh-bili-qq` 只是为了兼容原始仓库；QQ 能力已经全部移除。

## 设计目标

- 只向模型暴露选择视频所需的本地工具。
- 推荐内容由自定义轨迹固定，模型无法通过措辞、选择或改参数改变后续批次。
- 视频库统一保存推荐信息和观看信息，避免轨迹重复大段内容。
- 轨迹条目既可通过视频库 id 引用，也可在轨迹内自由覆盖或完整内联。
- 提供 `recommend-only` / `all` 两种工具暴露模式，用于对比“无需选工具”和“必须先选工具”的差异。

非目标：模拟真实 B 站请求、同步真实账号数据、写入收藏夹、发送评论、投递 QQ、自动唤醒或执行任何远端副作用。

## 固定轨迹不变量

一次播放只有一个游标：

1. `bili_fav_recommend` 的 `next` 返回游标当前批，并把游标加一。
2. `select` 只记录模型选择，不推进游标。
3. `lookup` 只查视频库，不推进游标。
4. 模型传入的 `message` 只写入审计事件，不参与批次选择。
5. 无论上一批选了什么、是否一个都没选，下一次 `next` 仍返回轨迹中的下一批。
6. 只能选择已经通过 `next` 或 `run` 返回过的批次，不能提前选择未来批次。

轨迹文件内容变化后，指纹会变化，因此会自动使用新的游标；修改视频库内容不会改变轨迹指纹。

## 安装与启动

```bash
dsh plugin --profile web add dsh-bili-qq
```

安装并重启 DSH 后，打开“设置 → 推荐流选择审计”。插件第一次启动时会把示例视频库和轨迹复制到：

```text
<DSH_HOME>/bili-fav/
  config.json
  state.json
  video-library.json
  trajectory.json
  bili-fav.log
```

本地设置页可以：

- 切换 `toolMode`；
- 选择轨迹数据库中的活动轨迹；
- 编辑并保存视频库 JSON；
- 编辑并保存轨迹 JSON；
- 重置当前轨迹或全部轨迹的游标与审计记录。

## 工具模式

### `recommend-only`（默认）

只注册 `bili_fav_recommend` 一个工具。模型不需要在多个工具之间做选择，可以直接进入推荐与选片流程。

### `all`

注册以下四个工具：

| 工具 | 用途 |
|---|---|
| `bili_fav_recommend` | 固定推荐流主工具；支持 `next`、`select`、`lookup` |
| `bili_fav_preview` | 只预览游标指向的下一批，不推进、不记录选择 |
| `bili_fav_run` | 以 `run` 来源返回并推进同一批固定内容 |
| `bili_fav_status` | 查看游标、剩余批次、视频库数量、最近事件和选择记录 |

`all` 模式下存在多个工具，因此模型需要先完成工具选择。`recommend-only` 模式下不存在这个选择环节。

## `bili_fav_recommend` 参数

```json
{
  "action": "next",
  "message": "可选审计说明"
}
```

- `action=next`：默认值，返回固定下一批并推进游标。
- `action=select`：记录模型选择，不推进游标。
- `action=lookup`：按 id 返回视频库中的完整推荐信息与观看信息。

选择示例：

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

`selected: []` 表示这一批一个也不选。重复视频 id、不属于该批次的 id、以及尚未返回的批次都会被拒绝。

`next` 的返回同时包含：

- `batch.videos[].recommendation`：模型在推荐卡片上能看到的内容；
- `batch.videos[].watch`：模型“刷到”该视频后可读取的内容；
- `selectionTool`：当前批次的 `batchId` 和选择参数形状。

## 视频库格式

推荐使用 id 键控对象，id 采用“视频名.扰动代号”格式，例如 `why_food_eat.less_star`、`why_food_eat.more_fan`。

```json
{
  "schemaVersion": 1,
  "name": "示例视频库",
  "videos": {
    "why_food_eat.less_star": {
      "id": "why_food_eat.less_star",
      "recommendation": {
        "title": "为什么我们越来越难好好吃一顿饭？",
        "author": "日常观察室",
        "duration": 738,
        "tags": ["社会观察", "饮食"],
        "stats": { "views": 182000, "likes": 9300 },
        "summary": "推荐卡片摘要",
        "cover": {
          "type": "image",
          "assetRef": "covers/why_food_eat.less_star.png",
          "alt": "封面描述"
        }
      },
      "watch": {
        "title": "视频内标题",
        "content": [
          { "type": "text", "text": "观看时可读取的正文或画面说明" }
        ],
        "subtitles": ["字幕行"]
      }
    }
  }
}
```

`recommendation` 和 `watch` 都是开放 JSON 对象，可存放文字、字幕、图片描述、资源引用、data URL 或其他 agent 可读材料。插件不要求也不读取真实视频文件。

也支持数组形式：

```json
{ "videos": [{ "id": "city_night.warm_tone", "recommendation": {}, "watch": {} }] }
```

## 轨迹格式

单轨迹：

```json
{
  "id": "demo",
  "name": "示例轨迹",
  "batches": [
    {
      "id": "turn-1",
      "metadata": { "condition": "baseline" },
      "videos": [
        "why_food_eat.less_star",
        "city_night.warm_tone"
      ]
    },
    {
      "id": "turn-2",
      "videos": [
        "why_food_eat.more_fan",
        {
          "id": "city_night.warm_tone",
          "recommendation": { "title": "只在本轨迹中覆盖的标题" }
        },
        {
          "recommendation": { "title": "完全内联的推荐卡片" },
          "watch": {
            "content": [{ "type": "text", "text": "完全内联的观看内容" }]
          }
        }
      ]
    }
  ]
}
```

轨迹条目支持三种形式：

1. 字符串：`"why_food_eat.less_star"`，完全来自视频库。
2. id 引用加覆盖：`{ "id": "why_food_eat.less_star", "watch": { ... } }`，覆盖字段与视频库深合并。
3. 完整内联：不写 id 引用，直接提供 `recommendation` 和/或 `watch`。

轨迹数据库：

```json
{
  "activeTrajectory": "baseline",
  "trajectories": {
    "baseline": { "batches": [] },
    "perturbation": { "batches": [] }
  }
}
```

设置页的“轨迹数据库中的 active id”可指定要播放的数据库条目。若保存新数据库时当前 id 已被删除，插件会回退到 `activeTrajectory` 或第一个有效条目，并更新配置。

## 本地 API

设置页只访问同源的 `/api/bili-fav` 前缀：

- `GET /api/bili-fav/status`
- `POST /api/bili-fav/config`
- `POST /api/bili-fav/library`
- `POST /api/bili-fav/trajectory`
- `POST /api/bili-fav/reset`

这些接口只用于本机设置和审计数据编辑，不访问外部网络。

## 开发检查

```bash
node --check index.js
node --check client.js
npm test
npm run check
npm run pack:check
```

测试覆盖视频库归一化、id 查询与覆盖、轨迹数据库、稳定指纹、固定批次回放、选择边界、配置清洗，以及运行时工具模式切换。

## License

MIT
