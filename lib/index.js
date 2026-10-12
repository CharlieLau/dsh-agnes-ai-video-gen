/**
 * dsh-agnes-ai-video-gen — a model-facing `generate_video` tool for the DeepSeek
 * Harness, backed by the Agnes AI video API (`agnes-video-2.5-flash`).
 *
 * Text-to-video, keyframe (first/last frame) and reference (images + audios)
 * modes all start with `POST {baseUrl}/v1/videos`, poll the task on
 * `{baseUrl}/agnesapi` until it settles, then download the mp4 into the
 * workspace. The API's `mode` field is derived from the arguments here — the
 * model never has to pick it.
 *
 * Deliberately dependency-free for the same reason as dsh-agnes-ai-image-gen:
 * the DSH loader imports this file straight from its absolute path, so only
 * `node:` builtins are imported. The tool definition is hand-built in the
 * shape `defineTool` produces, with `parameters` as a FULL JSON Schema —
 * `ctx.tools.register()` stores `parameters` verbatim and the provider adapter
 * sends them as `input_schema` unchanged, so anything less fails at the
 * provider on every turn.
 *
 * @module dsh-agnes-ai-video-gen
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-agnes-ai-video-gen'

/** Service required by this plugin: the tool registry. */
export const inject = ['tools']

/** Clip lengths the API accepts, as the string values it expects. */
const SECONDS_TIERS = ['4', '5', '6', '7', '8', '9', '10', '11', '12']
/** Aspect ratios the API accepts (720P tier). */
const RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
/** Default API origin; tasks are created on `/v1/videos` and polled on `/agnesapi`. */
const DEFAULT_BASE_URL = 'https://api.agnes-ai.cn'
/** Default model id. */
const DEFAULT_MODEL = 'agnes-video-2.5-flash'
/** Video generation is async and slow; the docs advise long client timeouts. */
const DEFAULT_TIMEOUT_MS = 600_000
/** Workspace-relative directory generated mp4s land in. */
const DEFAULT_OUTPUT_DIR = 'out/videos'
/** Credential reference resolved through `ctx.credentials` (then `process.env`). */
const DEFAULT_API_KEY_REF = 'AGNES_API_KEY'
/** Upper bound on the downloaded video size. */
const MAX_VIDEO_BYTES = 256 * 1024 * 1024
/** Upper bounds on reference material inlined into the request as data URIs. */
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_AUDIO_BYTES = 50 * 1024 * 1024
/** Reference-mode limits enforced by the API (verified 400 beyond these). */
const MAX_IMAGES = 5
const MAX_AUDIOS = 3
/** Poll cadence; the docs recommend 1–2 seconds, but that trips the 429 limit. */
const POLL_INTERVAL_MS = 3000
/** Ceiling for the rate-limit backoff. */
const POLL_INTERVAL_MAX_MS = 20000
/** Multiplier applied on each rate-limited poll. */
const POLL_BACKOFF = 1.5
/** Consecutive tolerated polling failures before giving up. */
const MAX_POLL_FAILURES = 3
/**
 * Backoff between create attempts on HTTP 503/429. A queue-full rejection
 * means the task was never created, so retrying cannot duplicate a video.
 */
const CREATE_RETRY_DELAYS = [0, 5_000, 15_000, 30_000, 60_000]

/**
 * Resolve a non-empty trimmed string, else the fallback.
 * @param {unknown} value - candidate.
 * @param {string | undefined} fallback - value used when the candidate is blank.
 * @returns {string | undefined} the resolved string.
 */
function text(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Resolve a positive integer, else the fallback.
 * @param {unknown} value - candidate.
 * @param {number} fallback - value used when the candidate is not a positive integer.
 * @returns {number} the resolved integer.
 */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Normalize the raw plugin config into fully-resolved settings.
 * @param {unknown} config - raw cordis plugin config.
 * @returns {object} resolved base URL, model, credential routing, timeout, and defaults.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    baseUrl: text(raw.baseUrl, DEFAULT_BASE_URL).replace(/\/+$/u, ''),
    model: text(raw.model, DEFAULT_MODEL),
    apiKey: text(raw.apiKey, undefined),
    apiKeyRef: text(raw.apiKeyRef, DEFAULT_API_KEY_REF),
    timeoutMs: positiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    outputDir: text(raw.outputDir, DEFAULT_OUTPUT_DIR),
    seconds: text(raw.seconds, '5'),
    ratio: text(raw.ratio, '16:9'),
    pollIntervalMs: positiveInt(raw.pollIntervalMs, POLL_INTERVAL_MS),
    pollIntervalMaxMs: positiveInt(raw.pollIntervalMaxMs, POLL_INTERVAL_MAX_MS),
    pollBackoff: typeof raw.pollBackoff === 'number' && Number.isFinite(raw.pollBackoff) && raw.pollBackoff >= 1
      ? raw.pollBackoff
      : POLL_BACKOFF,
  }
}

/**
 * Resolve the API key, preferring literal config, then the credential seam, then
 * the inherited environment. Nothing is cached, so a key stored through the
 * harness reaches the next call without a plugin reload.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} settings - resolved plugin settings.
 * @returns {Promise<string>} the non-empty bearer token.
 * @throws {Error} when no layer supplies a key.
 */
async function resolveApiKey(ctx, settings) {
  if (settings.apiKey !== undefined) return settings.apiKey
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(settings.apiKeyRef)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value
      }
    } catch {
      /* an unroutable credential is the same as a missing one here */
    }
  }
  const inherited = process.env[settings.apiKeyRef]
  if (typeof inherited === 'string' && inherited.trim().length > 0) return inherited.trim()
  throw new Error(
    `no video API key: store credential ${settings.apiKeyRef} (harness credentials, or an ${settings.apiKeyRef} entry in the harness/cwd .env), or set the plugin's config.apiKey`,
  )
}

/** Extension → media type for inlined reference material. */
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])
const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.flac', 'audio/flac'],
])

/**
 * Detect an image's real format from its leading bytes, so encrypted-CDN
 * octet-streams and missing extensions cannot mislabel the data URI.
 * @param {Uint8Array} data - image bytes.
 * @returns {string | undefined} the sniffed media type.
 */
function sniffImageMediaType(data) {
  const ascii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      if (data[offset + index] !== value.charCodeAt(index)) return false
    }
    return true
  }
  if (ascii(0, '\u0089PNG\r\n\u001a\n')) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * Media type for one reference file: extension first, byte sniffing as the
 * image fallback. Audio keeps a permissive default rather than guessing.
 * @param {string} path - the file path (only its extension is read).
 * @param {Uint8Array} data - file bytes.
 * @param {'image' | 'audio'} kind - reference kind.
 * @returns {string} the media type for the data URI.
 */
function referenceMediaType(path, data, kind) {
  const dot = path.lastIndexOf('.')
  if (dot !== -1) {
    const ext = path.slice(dot).toLowerCase()
    const mapped = (kind === 'image' ? IMAGE_TYPES : AUDIO_TYPES).get(ext)
    if (mapped !== undefined) return mapped
  }
  if (kind === 'image') {
    const sniffed = sniffImageMediaType(data)
    if (sniffed !== undefined) return sniffed
    return 'application/octet-stream'
  }
  return 'audio/mpeg'
}

/**
 * Turn one reference entry into something the provider accepts: a public HTTPS
 * URL, a `data:image/…` / `data:audio/…` URI, or a local path this function
 * reads off disk and inlines.
 *
 * The harness hands the model attachment paths like
 * `~/.dsh/attachments/v1/objects/ab/<sha256>`, and a model cannot echo a
 * several-hundred-kilobyte base64 blob back as a tool argument — so the read
 * has to happen here, not in the call.
 *
 * @param {string} entry - one `images` / `audios` / frame element.
 * @param {string} cwd - base directory for relative paths.
 * @param {'image' | 'audio'} kind - reference kind, for the data-URI prefix and limits.
 * @returns {Promise<string>} a public URL or a `data:` URI.
 * @throws {Error} when a local file is missing, too large, or unreadable.
 */
async function toReferenceMedia(entry, cwd, kind) {
  const label = kind === 'image' ? 'reference image' : 'reference audio'
  if (entry.startsWith('https://')) return entry
  if (entry.startsWith('data:')) {
    const prefix = kind === 'image' ? 'data:image/' : 'data:audio/'
    if (!entry.startsWith(prefix)) {
      throw new Error(`${label} "${entry.slice(0, 60)}" must be a ${prefix}… URI`)
    }
    return entry
  }
  let path
  if (entry.startsWith('file://')) {
    path = fileURLToPath(entry)
  } else if (/^[a-z][a-z0-9+.-]+:/iu.test(entry)) {
    // 两字符以上的 scheme 才算 URL；单字母留给 Windows 盘符（C:\…）。
    throw new Error(`${label} "${entry.slice(0, 60)}" must use https://, a ${prefix}… URI, or a local file path`)
  } else {
    path = isAbsolute(entry) ? entry : resolve(cwd, entry)
  }
  let data
  try {
    data = new Uint8Array(await readFile(path))
  } catch (error) {
    throw new Error(`cannot read ${label} "${entry}": ${error instanceof Error ? error.message : String(error)}`)
  }
  if (data.byteLength === 0) throw new Error(`${label} "${entry}" is empty`)
  const limit = kind === 'image' ? MAX_REFERENCE_IMAGE_BYTES : MAX_REFERENCE_AUDIO_BYTES
  if (data.byteLength > limit) {
    throw new Error(`${label} "${entry}" is ${data.byteLength} bytes, above the ${limit}-byte limit for inlined references`)
  }
  return `data:${referenceMediaType(path, data, kind)};base64,${Buffer.from(data).toString('base64')}`
}

/**
 * Resolve every reference entry, preserving order. Stops at the first failure so
 * the caller never sends a partially-substituted batch.
 * @param {readonly string[] | undefined} entries - classified entries.
 * @param {string} cwd - base directory for relative paths.
 * @param {'image' | 'audio'} kind - reference kind.
 * @returns {Promise<string[] | undefined>} provider-ready references, or undefined when there are none.
 */
async function materializeReferences(entries, cwd, kind) {
  if (entries === undefined || entries.length === 0) return undefined
  const resolved = []
  for (const entry of entries) resolved.push(await toReferenceMedia(entry, cwd, kind))
  return resolved
}

/**
 * Interruptible sleep for the polling loop.
 * @param {number} ms - how long to wait.
 * @param {AbortSignal} signal - aborting rejects with an AbortError.
 */
function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(resolvePromise, ms)
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      rejectPromise(error)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * POST the task. The docs' prose says `/v1/videos` while their curl examples
 * use `/videos`, so `/v1` goes first and a 404/405 falls back once.
 * @param {object} settings - resolved plugin settings.
 * @param {string} apiKey - bearer token.
 * @param {object} body - fully-materialized request body.
 * @param {AbortSignal} signal - combined caller/timeout cancellation.
 * @returns {Promise<string>} the task id.
 * @throws {Error} on a non-2xx response or a body without a task id.
 */
async function createVideoTask(settings, apiKey, body, signal) {
  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }
  let queueFull
  for (let attempt = 0; attempt < CREATE_RETRY_DELAYS.length; attempt += 1) {
    if (CREATE_RETRY_DELAYS[attempt] > 0) await sleep(CREATE_RETRY_DELAYS[attempt], signal)
    let response = await fetch(`${settings.baseUrl}/v1/videos`, init)
    if (response.status === 404 || response.status === 405) {
      response = await fetch(`${settings.baseUrl}/videos`, init)
    }
    const payloadText = await response.text()
    if (response.status === 503 || response.status === 429) {
      // 队列满/限流：任务未创建，重试不会重复出片。
      queueFull = new Error(`video API queue is full (HTTP ${response.status}): ${payloadText.slice(0, 300)}`)
      continue
    }
    if (!response.ok) {
      throw new Error(`video API returned HTTP ${response.status}: ${payloadText.slice(0, 600)}`)
    }
    let payload
    try {
      payload = JSON.parse(payloadText)
    } catch {
      throw new Error(`video API returned a non-JSON body: ${payloadText.slice(0, 600)}`)
    }
    const taskId = text(payload?.id, undefined) ?? text(payload?.task_id, undefined) ?? text(payload?.data?.id, undefined)
    if (taskId === undefined) {
      throw new Error(`video API returned no task id: ${payloadText.slice(0, 600)}`)
    }
    return taskId
  }
  throw queueFull
}

/**
 * Poll the task until it settles. Only `status` and `progress` are trusted
 * (the docs warn `internal_status` lies), and a few transient polling errors
 * are tolerated before giving up.
 * @param {object} settings - resolved plugin settings.
 * @param {string} apiKey - bearer token.
 * @param {string} taskId - the id returned by {@link createVideoTask}.
 * @param {AbortSignal} signal - combined caller/timeout cancellation.
 * @returns {Promise<{url: string, taskId: string}>} the completed video URL.
 * @throws {Error} when the task fails or polling exhausts its tolerance.
 */
/**
 * Poll the task until it settles. Only `status` and `progress` are trusted
 * (the docs warn `internal_status` lies).
 *
 * Rate limiting is NOT a failure. The docs recommend 1–2s polling, but the
 * endpoint answers `429 查询过于频繁` well before that in practice, and a task
 * that is happily rendering must never be thrown away because we asked too
 * often — that is exactly how a finished video gets reported as a failure.
 * So 429/503 back the interval off and do not touch the failure budget, which
 * is reserved for errors that mean the task itself is unreachable.
 *
 * @param {object} settings - resolved plugin config.
 * @param {string} apiKey - bearer token.
 * @param {string} taskId - the id returned by {@link createVideoTask}.
 * @param {AbortSignal} signal - combined caller/timeout cancellation.
 * @returns {Promise<{url: string, taskId: string}>} the completed video URL.
 * @throws {Error} when the task fails or polling exhausts its tolerance.
 */
async function pollVideoTask(settings, apiKey, taskId, signal) {
  const url =
    `${settings.baseUrl}/agnesapi?video_id=${encodeURIComponent(taskId)}` +
    `&model_name=${encodeURIComponent(settings.model)}`
  let failures = 0
  let interval = settings.pollIntervalMs
  for (;;) {
    let payload
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal })
      const payloadText = await response.text()
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${payloadText.slice(0, 300)}`)
        error.status = response.status
        throw error
      }
      payload = JSON.parse(payloadText)
      failures = 0
      interval = settings.pollIntervalMs
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // 被限流只说明我们问得太勤，不代表任务有问题：放慢但不记账。
      if (error?.status === 429 || error?.status === 503) {
        interval = Math.min(Math.round(interval * settings.pollBackoff), settings.pollIntervalMaxMs)
      } else {
        failures += 1
        if (failures >= MAX_POLL_FAILURES) {
          throw new Error(
            `polling video task ${taskId} failed repeatedly: ${error instanceof Error ? error.message : String(error)}` +
            `（任务可能仍在生成，可用 video_id=${taskId} 手动查询）`,
          )
        }
      }
    }
    if (payload !== undefined) {
      const status = text(payload?.status, undefined)
      if (status === 'completed' || status === 'succeeded') {
        const videoUrl = text(payload?.url, undefined)
        if (videoUrl === undefined) {
          throw new Error(`video task ${taskId} completed without a url: ${JSON.stringify(payload).slice(0, 400)}`)
        }
        return { url: videoUrl, taskId }
      }
      if (status === 'failed') {
        const reason = payload?.error === null || payload?.error === undefined ? '' : `: ${JSON.stringify(payload.error).slice(0, 400)}`
        throw new Error(`video task ${taskId} failed${reason}`)
      }
    }
    await sleep(interval, signal)
  }
}

/**
 * Whether the downloaded bytes look like an ISO-BMFF mp4 (bytes 4–7 = "ftyp").
 * @param {Uint8Array} data - downloaded bytes.
 * @returns {boolean} true when the ftyp box is present.
 */
function mp4LooksValid(data) {
  return data.length > 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70
}

/**
 * Fetch the generated mp4.
 * @param {string} url - the completed task's video url.
 * @param {AbortSignal} signal - combined caller/timeout cancellation.
 * @returns {Promise<Uint8Array>} the encoded video bytes.
 * @throws {Error} when the download fails, exceeds the size bound, or is not an mp4.
 */
async function fetchVideoBytes(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`downloading the generated video failed: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
    throw new Error(`the generated video is ${declared} bytes, above the ${MAX_VIDEO_BYTES}-byte limit`)
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(`the generated video is ${buffer.byteLength} bytes, above the ${MAX_VIDEO_BYTES}-byte limit`)
  }
  if (!mp4LooksValid(buffer)) {
    throw new Error('the generated video does not look like an mp4 (no ftyp box)')
  }
  return buffer
}

/**
 * Validate and normalize one tool call's arguments, deriving the API mode.
 * @param {object} args - schema-validated arguments.
 * @param {object} settings - resolved plugin settings.
 * @returns {{prompt: string, seconds: string, ratio: string, mode: 'text' | 'keyframe' | 'reference', firstFrame: string | undefined, lastFrame: string | undefined, images: readonly string[] | undefined, audios: readonly string[] | undefined, saveDir: string | undefined, fileName: string | undefined}} the request fields.
 * @throws {Error} on an empty prompt, unknown tier/ratio, or bad reference arrays.
 */
function parseArgs(args, settings) {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
  // The API wants seconds as a string; accept a number and normalize it.
  const rawSeconds = typeof args.seconds === 'number' && Number.isInteger(args.seconds) ? String(args.seconds) : args.seconds
  const seconds = text(rawSeconds, settings.seconds)
  if (!SECONDS_TIERS.includes(seconds)) {
    throw new Error(`unsupported seconds "${seconds}"; use one of ${SECONDS_TIERS.join(', ')}`)
  }
  const ratio = text(args.ratio, settings.ratio)
  if (!RATIOS.includes(ratio)) {
    throw new Error(`unsupported ratio "${ratio}"; use one of ${RATIOS.join(', ')}`)
  }
  const firstFrame = text(args.first_frame, undefined)
  const lastFrame = text(args.last_frame, undefined)
  const readSet = (value, label, max) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
      throw new Error(`${label} must be an array of non-empty strings`)
    }
    const trimmed = value.map((entry) => entry.trim())
    if (trimmed.length > max) {
      throw new Error(`${label} has ${trimmed.length} entries; the API accepts at most ${max}`)
    }
    return trimmed
  }
  const images = readSet(args.images, 'images', MAX_IMAGES)
  const audios = readSet(args.audios, 'audios', MAX_AUDIOS)
  const mode = firstFrame !== undefined || lastFrame !== undefined
    ? 'keyframe'
    : (images !== undefined && images.length > 0) || (audios !== undefined && audios.length > 0)
      ? 'reference'
      : 'text'
  return {
    prompt,
    seconds,
    ratio,
    mode,
    firstFrame,
    lastFrame,
    images: images !== undefined && images.length > 0 ? images : undefined,
    audios: audios !== undefined && audios.length > 0 ? audios : undefined,
    saveDir: text(args.save_dir, undefined),
    fileName: text(args.name, undefined),
  }
}

/**
 * Format the model-facing text envelope. No video content block: the harness
 * attachment seam only stores images, so the file path is the deliverable.
 * @param {object} value - the canonical tool output value.
 * @returns {string} the envelope text.
 */
function formatOutput(value) {
  const lines = [
    `<path>${value.path}</path>`,
    `<model>${value.model}</model>`,
    `<mode>${value.mode}</mode>`,
    `<requested>${value.seconds}s ${value.ratio} 720P</requested>`,
    `<bytes>${value.bytes}</bytes>`,
  ]
  if (value.taskId !== undefined) lines.push(`<task_id>${value.taskId}</task_id>`)
  if (value.sourceUrl !== undefined) lines.push(`<source_url>${value.sourceUrl}</source_url>`)
  lines.push(`<prompt>${value.prompt}</prompt>`)
  lines.push('The video is saved locally at the path above. Call `present` on it to show the user a preview card.')
  return lines.join('\n')
}

/**
 * Register the `generate_video` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the registration scope.
 * @param {object} settings - resolved plugin settings.
 */
function applyGenerateVideoTool(ctx, settings) {
  ctx.tools.register({
    name: 'generate_video',
    description:
      `Generate a short video clip with the Agnes ${settings.model} model and save it as an mp4 into the workspace. ` +
      'Handles text-to-video, first/last keyframe animation, and multi-reference composition (images drive look and feel, audios drive sound). ' +
      'Prompt structure: [subject] + [action/motion] + [scene] + [style] + [camera movement]; in reference mode use <Picture 1>, <Audio 1> to point at the provided material.',
    // Full JSON Schema on purpose: the registry stores this verbatim and the
    // provider adapter forwards it as `input_schema` — there is no compilation.
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description:
            'What the clip shows. Write motion explicitly (subject, action, camera movement). With images/audios provided, refer to them as <Picture 1>, <Audio 1>, …',
        },
        seconds: {
          type: 'string',
          description: `Clip length: ${SECONDS_TIERS.join(' | ')} (default ${settings.seconds}). Sent as a string.`,
        },
        ratio: {
          type: 'string',
          description: `Aspect ratio: ${RATIOS.join(' | ')} (default ${settings.ratio}). Resolution is fixed at 720P.`,
        },
        first_frame: {
          type: 'string',
          description:
            'First-frame still (keyframe mode): a local file path, file:// URL, public HTTPS URL, or data:image/... URI. Provide first_frame and/or last_frame to steer the clip from stills.',
        },
        last_frame: {
          type: 'string',
          description: 'Last-frame still (keyframe mode); same accepted forms as first_frame.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `Reference images for look/style/identity (at most ${MAX_IMAGES}): local file paths, file:// URLs, public HTTPS URLs, or data:image/... URIs. Refer to them in the prompt as <Picture 1>…`,
        },
        audios: {
          type: 'array',
          items: { type: 'string' },
          description: `Reference audio tracks (at most ${MAX_AUDIOS}): local file paths, file:// URLs, public HTTPS URLs, or data:audio/... URIs. Refer to them in the prompt as <Audio 1>…`,
        },
        save_dir: {
          type: 'string',
          description: `Directory for the generated mp4; workspace-relative unless absolute. Defaults to the plugin output directory (${settings.outputDir}).`,
        },
        name: {
          type: 'string',
          description: 'Optional base name for the saved file (a timestamp and .mp4 are appended).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'prompt', 'model', 'mode', 'seconds', 'ratio', 'bytes'],
        properties: {
          path: { type: 'string' },
          prompt: { type: 'string' },
          model: { type: 'string' },
          mode: { type: 'string' },
          seconds: { type: 'string' },
          ratio: { type: 'string' },
          bytes: { type: 'integer' },
          sourceUrl: { type: 'string' },
          taskId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatOutput(value) }],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseArgs(args, settings)
      const apiKey = await resolveApiKey(ctx, settings)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(settings.timeoutMs)].filter(Boolean))
      const cwd = process.cwd()
      const firstFrame = parsed.firstFrame === undefined ? undefined : await toReferenceMedia(parsed.firstFrame, cwd, 'image')
      const lastFrame = parsed.lastFrame === undefined ? undefined : await toReferenceMedia(parsed.lastFrame, cwd, 'image')
      const images = await materializeReferences(parsed.images, cwd, 'image')
      const audios = await materializeReferences(parsed.audios, cwd, 'audio')
      const body = {
        model: settings.model,
        prompt: parsed.prompt,
        mode: parsed.mode,
        seconds: parsed.seconds,
        size: '720P',
        aspect_ratio: parsed.ratio,
        ...(parsed.mode === 'keyframe'
          ? {
              ...(firstFrame === undefined ? {} : { first_frame: firstFrame }),
              ...(lastFrame === undefined ? {} : { last_frame: lastFrame }),
            }
          : {}),
        ...(parsed.mode === 'reference'
          ? {
              ...(images === undefined ? {} : { images }),
              ...(audios === undefined ? {} : { audios }),
            }
          : {}),
      }
      const taskId = await createVideoTask(settings, apiKey, body, signal)
      const outcome = await pollVideoTask(settings, apiKey, taskId, signal)
      const data = await fetchVideoBytes(outcome.url, signal)
      const directory = isAbsolute(settings.outputDir) ? settings.outputDir : resolve(process.cwd(), settings.outputDir)
      const target = parsed.saveDir === undefined
    ? join(directory, `${slugify(parsed.fileName ?? parsed.prompt)}-${stamp(new Date())}.mp4`)
    : join(isAbsolute(parsed.saveDir) ? parsed.saveDir : resolve(process.cwd(), parsed.saveDir), `${slugify(parsed.fileName ?? parsed.prompt)}-${stamp(new Date())}.mp4`)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, data)
      return {
        path: target,
        prompt: parsed.prompt,
        model: settings.model,
        mode: parsed.mode,
        seconds: parsed.seconds,
        ratio: parsed.ratio,
        bytes: data.byteLength,
        sourceUrl: outcome.url,
        taskId: outcome.taskId,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `generate_video: ${String(args.prompt ?? '').slice(0, 80)}`,
        kind: 'video',
        rawInput: `${args.seconds ?? settings.seconds}s ${args.ratio ?? settings.ratio}`,
      }
    },
  })
}

/**
 * Build a filesystem-safe slug from a prompt.
 * @param {string} prompt - the video prompt.
 * @returns {string} at most 40 characters of `[a-z0-9-]`, never empty.
 */
function slugify(prompt) {
  const slug = prompt
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '')
  return slug.length > 0 ? slug : 'video'
}

/**
 * Local timestamp rendered as `YYYYMMDD-HHmmss` in local time.
 * @param {Date} now - the instant to render.
 * @returns {string} the compact stamp.
 */
function stamp(now) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

/**
 * Register the video-generation tool. The tools registry is effect-scoped, so
 * the registration disposes with this plugin's fiber and needs no teardown.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {unknown} config - raw plugin config.
 */
export function apply(ctx, config) {
  applyGenerateVideoTool(ctx, resolveSettings(config))
}

/** Exported for tests. */
export const internals = {
  parseArgs,
  resolveSettings,
  toReferenceMedia,
  materializeReferences,
  createVideoTask,
  pollVideoTask,
  fetchVideoBytes,
  mp4LooksValid,
}
