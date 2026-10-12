/**
 * Standalone smoke test for the dsh-agnes-ai-video-gen plugin.
 *
 * It builds a minimal fake cordis context, captures the registered tool
 * definition, asserts both schemas against the real `@deepseek-ai/dsh-tools`
 * validator (so a schema the live loader would reject fails here first), then
 * runs one real generation against the Agnes video API (text mode, 4s — free
 * during the promo window).
 *
 * Usage:
 *   AGNES_API_KEY=sk-... node test/smoke.mjs [--offline]
 */

import { join, resolve } from 'node:path'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const DSH_TOOLS =
  process.env.DSH_TOOLS_PATH ??
  '/Users/charlie/.nvm/versions/node/v24.14.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(DSH_TOOLS)
const plugin = await import(resolve(import.meta.dirname, '../lib/index.js'))

const offline = process.argv.includes('--offline')
const failures = []

/** @param {boolean} condition @param {string} label */
function check(condition, label) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    console.log(`  FAIL ${label}`)
    failures.push(label)
  }
}

console.log('plugin exports')
check(plugin.name === 'dsh-agnes-ai-video-gen', 'name is dsh-agnes-ai-video-gen')
check(Array.isArray(plugin.inject) && plugin.inject.includes('tools'), 'inject declares tools')
check(typeof plugin.apply === 'function', 'apply is a function')

console.log('registration')
const registered = []
const fakeCtx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  get() {
    return undefined
  },
}
plugin.apply(fakeCtx, { apiKey: process.env.AGNES_API_KEY ?? 'unused', outputDir: 'out/videos' })
check(registered.length === 1, 'registered exactly one tool')
const tool = registered[0]
check(tool.name === 'generate_video', 'tool name is generate_video')
check(typeof tool.execute === 'function', 'tool has execute')
check(typeof tool.output.render === 'function', 'tool has output.render')
check(tool.timeoutMs > 0, 'tool declares a positive timeout')

console.log('schema acceptance (the live loader path)')
try {
  assertSupportedJsonSchema(tool.output.schema)
  check(true, 'output schema is in the supported subset')
} catch (error) {
  check(false, `output schema rejected: ${error.message}`)
}

// The registry stores `parameters` verbatim and the provider adapter sends them
// as `input_schema` unchanged, so this must already be a full object-rooted
// JSON Schema — a flat property map made DeepSeek reject every turn with
// "got 'type: null'" (the image plugin's 2026-10-10 incident).
const parameterSchema = tool.parameters
check(
  parameterSchema?.type === 'object' && typeof parameterSchema?.properties === 'object',
  'parameter schema is a full object-rooted JSON Schema (providers receive it verbatim)',
)
try {
  assertSupportedJsonSchema(parameterSchema)
  check(true, 'parameter schema is in the supported subset')
} catch (error) {
  check(false, `parameter schema rejected: ${error.message}`)
}

console.log('argument validation')
check(
  validateJsonSchemaValue(parameterSchema, { prompt: 'a cat walking' }, '').length === 0,
  'a minimal valid call validates',
)
check(validateJsonSchemaValue(parameterSchema, {}, '').length > 0, 'a call without prompt is refused')
check(validateJsonSchemaValue(parameterSchema, { prompt: 5 }, '').length > 0, 'a non-string prompt is refused')

console.log('argument parsing and mode derivation')
const { parseArgs, resolveSettings } = plugin.internals
const settings = resolveSettings({})
const parsed = parseArgs({ prompt: '  hello  ', seconds: '6', ratio: '9:16' }, settings)
check(parsed.prompt === 'hello', 'prompt is trimmed')
check(parsed.seconds === '6' && parsed.ratio === '9:16', 'explicit seconds and ratio are kept')
check(parsed.mode === 'text', 'no references derives text mode')
check(parseArgs({ prompt: 'x' }, settings).seconds === '5', 'seconds defaults to 5')
check(parseArgs({ prompt: 'x' }, settings).ratio === '16:9', 'ratio defaults to 16:9')
check(parseArgs({ prompt: 'x', seconds: 6 }, settings).seconds === '6', 'a numeric seconds is normalized to a string')
check(parseArgs({ prompt: 'x', first_frame: 'a.png' }, settings).mode === 'keyframe', 'a first frame derives keyframe mode')
check(parseArgs({ prompt: 'x', last_frame: 'b.png' }, settings).mode === 'keyframe', 'a last frame derives keyframe mode')
check(parseArgs({ prompt: 'x', images: ['c.png'] }, settings).mode === 'reference', 'images derive reference mode')
check(parseArgs({ prompt: 'x', audios: ['d.mp3'] }, settings).mode === 'reference', 'audios derive reference mode')
check(parseArgs({ prompt: 'x', images: [] }, settings).mode === 'text', 'an empty images array stays text mode')
for (const [label, args] of [
  ['empty prompt', { prompt: '   ' }],
  ['unknown seconds', { prompt: 'x', seconds: '3' }],
  ['non-tier seconds', { prompt: 'x', seconds: '13' }],
  ['unknown ratio', { prompt: 'x', ratio: '5:4' }],
  ['too many images', { prompt: 'x', images: ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'] }],
  ['too many audios', { prompt: 'x', audios: ['1.mp3', '2.mp3', '3.mp3', '4.mp3'] }],
  ['non-string images', { prompt: 'x', images: [5] }],
]) {
  let threw = false
  try {
    parseArgs(args, settings)
  } catch {
    threw = true
  }
  check(threw, `refuses ${label}`)
}

console.log('reference materialization')
const { toReferenceMedia, materializeReferences, mp4LooksValid } = plugin.internals

{
  // A 1x1 PNG, so the data URI is a real image rather than a placeholder.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const dir = await mkdtemp(join(tmpdir(), 'dsh-agnes-ai-video-gen-'))
  const file = join(dir, 'probe.png')
  await writeFile(file, png)
  try {
    check((await toReferenceMedia('https://example.com/a.png', dir, 'image')) === 'https://example.com/a.png', 'an https image URL passes through')
    check(
      (await toReferenceMedia('data:image/png;base64,AAAA', dir, 'image')) === 'data:image/png;base64,AAAA',
      'a data:image URI passes through',
    )
    check(
      (await toReferenceMedia('data:audio/mpeg;base64,AAAA', dir, 'audio')) === 'data:audio/mpeg;base64,AAAA',
      'a data:audio URI passes through for audio kind',
    )
    const inline = await toReferenceMedia(file, dir, 'image')
    check(inline.startsWith('data:image/png;base64,'), 'a local image path becomes a data:image/png URI')
    check(Buffer.from(inline.split(',')[1], 'base64').equals(png), 'the inlined image bytes round-trip exactly')
    const inlineAudio = await toReferenceMedia(join(dir, 'probe.mp3'), dir, 'audio').catch(() => undefined)
    check(inlineAudio === undefined, 'a missing audio file is refused')
    for (const [label, entry, kind] of [
      ['an http:// image URL', 'http://example.com/a.png', 'image'],
      ['a data:image entry for audio kind', 'data:image/png;base64,AAAA', 'audio'],
      ['a data:audio entry for image kind', 'data:audio/mpeg;base64,AAAA', 'image'],
      ['a non-file scheme', 'ftp://example.com/a.png', 'image'],
      ['a missing file', join(dir, 'nope.png'), 'image'],
    ]) {
      let threw = false
      try {
        await toReferenceMedia(entry, dir, kind)
      } catch {
        threw = true
      }
      check(threw, `refuses ${label}`)
    }
    check((await materializeReferences(undefined, dir, 'image')) === undefined, 'no references stays undefined')
    check((await materializeReferences([], dir, 'image')) === undefined, 'an empty batch stays undefined')
    check(
      (await materializeReferences([file, 'https://example.com/b.png'], dir, 'image')).length === 2,
      'a mixed batch keeps order and length',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  check(mp4LooksValid(png) === false, 'a PNG is not mistaken for an mp4')
  const ftyp = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0])
  check(mp4LooksValid(ftyp) === true, 'bytes with an ftyp box look like an mp4')
}

console.log('polling survives rate limiting')
{
  const { pollVideoTask } = plugin.internals
  const settings = {
    baseUrl: 'https://api.example.test',
    model: 'agnes-video-2.5-flash',
    // 压缩退避表，否则这组用例要真睡一分多钟。
    pollIntervalMs: 1,
    pollIntervalMaxMs: 2,
    pollBackoff: 1.5,
  }
  const realFetch = globalThis.fetch
  /** 用假的 fetch 替掉网络，按脚本逐次作答。 */
  const stub = (script) => {
    let index = 0
    globalThis.fetch = async () => {
      const step = script[index++]
      if (step === undefined) throw new Error(`stub exhausted after ${index} calls`)
      if (step === 429 || step === 503 || step === 500) {
        return { ok: false, status: step, text: async () => `{"error":{"code":${step}}}` }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(step) }
    }
    return () => index
  }
  const started = Date.now()
  try {
    // 连续 6 次限流（远超旧的 3 次上限）之后任务完成 —— 必须仍然拿到结果。
    const calls = stub([429, 429, 429, 429, 429, 429, { status: 'completed', url: 'https://cdn.test/v.mp4' }])
    const done = await pollVideoTask(settings, 'k', 'task_x', new AbortController().signal)
    check(done.url === 'https://cdn.test/v.mp4', '429 does not abort a task that later completes')
    check(calls() === 7, `kept polling through 6 rate limits (saw ${calls()} polls)`)

    // 非限流错误仍然只容忍 3 次，但要带上任务号，便于手动查回。
    stub([500, 500, 500, { status: 'completed', url: 'https://cdn.test/never.mp4' }])
    let message = ''
    try {
      await pollVideoTask(settings, 'k', 'task_keepme', new AbortController().signal)
    } catch (error) {
      message = error.message
    }
    check(message.includes('task_keepme'), 'giving up names the task id so it can be queried by hand')
    check(message.includes('仍在生成'), 'giving up says the task may still be running')
  } finally {
    globalThis.fetch = realFetch
  }
  console.log(`  （轮询用例耗时 ${Date.now() - started}ms —— 退避表把等待压短了）`)
}

if (offline) {
  console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} (offline: skipped live generation)`)
  process.exit(failures.length === 0 ? 0 : 1)
}

console.log('live generation (text mode, 4s — free during the promo window)')
if (process.env.AGNES_API_KEY === undefined || process.env.AGNES_API_KEY.trim().length === 0) {
  console.log('  skip AGNES_API_KEY is not set')
} else {
  const controller = new AbortController()
  const value = await tool.execute(
    { prompt: 'A calm ocean wave rolling onto a sandy beach at sunrise, gentle motion, soft warm light, steady camera', seconds: '4', ratio: '16:9' },
    { signal: controller.signal, agent: undefined },
  )
  const violations = validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), '')
  check(violations.length === 0, `output value matches its schema${violations.length === 0 ? '' : `: ${violations.join('; ')}`}`)
  const info = await stat(value.path)
  check(info.size === value.bytes && info.size > 10_000, `saved ${value.bytes} bytes at ${value.path}`)
  const blocks = tool.output.render({}, value)
  check(blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.includes(value.path), 'render emits the path envelope')
  check(value.taskId !== undefined, `provider task id: ${value.taskId}`)
  check(value.mode === 'text', 'live run reports text mode')
}

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`)
process.exit(failures.length === 0 ? 0 : 1)
