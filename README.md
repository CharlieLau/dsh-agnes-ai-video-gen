# dsh-agnes-ai-video-gen

一个给 DSH 加「生视频」能力的插件：注册一个 `generate_video` 工具，后端走
[Agnes AI](https://www.agnes-ai.cn/zh-Hans/docs/agnes-video-25-flash) 的
`agnes-video-2.5-flash`（写这篇文章时**限时免费**，原价 ¥0.15/秒）。

支持**文生视频 / 首尾帧（keyframe）/ 多参考（reference：图 + 音）**三种模式。
`mode` 不暴露给模型，由参数自动推导：

| 传了什么 | 推导模式 |
| - | - |
| `first_frame` 或 `last_frame` | `keyframe` |
| `images`（≤5）或 `audios`（≤3） | `reference` |
| 都不传 | `text` |

时长 `4`–`12` 秒（API 要**字符串**），分辨率固定 `720P`，宽高比
`21:9 16:9 4:3 1:1 3:4 9:16`。生成的 mp4 落盘到工作区，输出里带
`path` / `taskId` / `sourceUrl`；提示词里可以用 `<Picture 1>`、`<Audio 1>`
指代参考素材（官方语法）。

## API 形态（异步任务）

- 创建：`POST {baseUrl}/v1/videos`，Bearer 认证。⚠️ 官方文档正文写 `/v1/videos`、
  curl 示例却写 `/videos`——插件先试 `/v1`，404/405 时回落 `/videos` 一次。
- 轮询：`GET {baseUrl}/agnesapi?video_id=…&model_name=agnes-video-2.5-flash`，
  1.5s 一次，只认 `status`/`progress`（文档警告 `internal_status` 不可信），
  连续 3 次轮询失败才放弃。
- 完成：顶层 `url` 是 mp4 下载地址；下载后校验 ftyp 盒再落盘。

## 为什么是自包含的

DSH 的 loader 按**绝对路径** import 插件，而 profile 的 `node_modules` 里没有
`@deepseek-ai/*`，所以插件只 import `node:` 内置模块，工具定义手工写成
`defineTool()` 产出的同一形状。结构与姊妹插件
[dsh-agnes-ai-image-gen](../dsh-agnes-ai-image-gen) 一一对应。

## 安装

1. 凭据：与生图插件**共用** `AGNES_API_KEY`（先在
   [Agnes AI](https://www.agnes-ai.cn/zh-Hans/docs/agnes-video-25-flash) 注册并创建
   API key），写进 `~/.dsh/.env`（`dsh-credentials-local` 会读 `$DSH_HOME/.env`）：

   ```sh
   install -m 600 /dev/null ~/.dsh/.env
   printf 'AGNES_API_KEY=%s\n' 'sk-...' >> ~/.dsh/.env
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加一个 `insert` 条目：

   ```yaml
   - insert:
       - id: video-gen
         name: /Users/charlie/work/dsh/plugins/dsh-agnes-ai-video-gen/lib/index.js
         config:
           baseUrl: https://api.agnes-ai.cn
           model: agnes-video-2.5-flash
           outputDir: out/videos
           apiKeyRef: AGNES_API_KEY
           timeoutMs: 600000
   ```

   改完这个文件会触发 HMR，**不用重启** `dsh web`。无头单次跑：

   ```sh
   dsh --profile headless --patch ~/work/dsh/plugins/dsh-agnes-ai-video-gen/cordis.patch.yml "画一段海浪视频"
   ```

## 配置项

| 键 | 默认 | 说明 |
| - | - | - |
| `apiKey` | — | 直接写字面 key（优先级最高，不推荐） |
| `apiKeyRef` | `AGNES_API_KEY` | 走 `ctx.credentials` 解析的凭据引用；解析不到时回落到同名环境变量 |
| `baseUrl` | `https://api.agnes-ai.cn` | API 源站 |
| `model` | `agnes-video-2.5-flash` | 目前文档只列了这一个视频模型 |
| `outputDir` | `out/videos` | 相对 host 进程 cwd（也就是工作区根）解析 |
| `timeoutMs` | `600000` | 覆盖创建 + 轮询 + 下载全程；视频是异步任务，别设太短 |
| `seconds` | `5` | 模型不传 `seconds` 时的默认时长 |
| `ratio` | `16:9` | 模型不传 `ratio` 时的默认宽高比 |

## 工具参数

| 参数 | 必填 | 说明 |
| - | - | - |
| `prompt` | ✅ | 提示词，结构：`[主体]+[动作/运动]+[场景]+[风格]+[运镜]`；reference 模式用 `<Picture 1>`/`<Audio 1>` 引用素材 |
| `seconds` | | `"4"`–`"12"`（字符串），默认 `5`；传数字也会被归一成字符串 |
| `ratio` | | 宽高比，默认 `16:9`；分辨率固定 720P |
| `first_frame` / `last_frame` | | 首帧/尾帧图（keyframe 模式），至少给一个；本地路径、`file://`、HTTPS URL、`data:image/...` 都行 |
| `images` | | 参考图，最多 5 张，接受形式同上；本地文件会被读出并内联为 data URI |
| `audios` | | 参考音频，最多 3 段；本地路径、`file://`、HTTPS URL、`data:audio/...` |
| `save_dir` | | 另存目录，相对工作区或绝对路径 |
| `name` | | 文件名前缀 |

参考素材上限：图片单张 20MB、音频单段 50MB（内联 base64 会让请求体膨胀约 1/3，
太大会拖慢创建）。

## 测试

```sh
node test/smoke.mjs --offline          # schema / 参数推导 / 模式判定 / 素材规则，不联网
AGNES_API_KEY=sk-... node test/smoke.mjs   # 上面那些 + 真打一次 4 秒文生视频并落盘
```

离线用例用真正的 `@deepseek-ai/dsh-tools` 校验器过一遍两个 schema，
「loader 会拒绝的 schema」在这里就会红。

## 坑（沿用姊妹插件的教训）

- **`parameters` 必须是完整 JSON Schema**：`ctx.tools.register()` 原样存、
  provider 原样发，扁平属性表会让**每个回合**都 400（`got 'type: null'`），
  而且注册期完全静默。`output.schema` 的 `required` 也必须写对象级数组。
- **视频不回传内容块**：harness 附件系统只有 `saveImage`，没有视频附件，
  所以输出是纯文本信封 + 落盘路径，让模型调 `present` 出预览卡。
- **`seconds` 是字符串**：文档里 `"4"`–`"12"` 全带引号，传数字会被部分网关拒；
  插件已做归一。
- **大小写敏感**：`size` 恒为 `"720P"`（小写 `720p` 会 400），写死在插件里不给模型。
- DNS 被污染的环境（运营商把 `api.agnes-ai.cn` 解析到自签证书的跳转盒）会让
  fetch 报 `fetch failed`——那是网络问题不是插件问题，改公共 DNS 即可。
