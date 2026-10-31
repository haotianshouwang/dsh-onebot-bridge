// 语音合成（TTS）：把文字合成为语音，并以 QQ 语音消息发到当前聊天。
//
// 设计边界：
// - 语音来源可插拔：local = 本机 Windows 系统语音（离线、零外部服务）；
//   siliconflow = 硅基流动 CosyVoice；custom = 任意兼容 OpenAI /v1/audio/speech 的自建服务。
// - 合成结果只通过 SDK 的资源服务绑定到当前聊天，再由核心 qq.audio.send 发出；
//   插件不接触任意本机路径，也不直接调用 OneBot 原始 action。
// - 网络地址、音色和密钥来自主人设置，模型只能传要朗读的文字，不能改目标服务。
// - 动作默认停用：主人需要在“主人与权限”里启用 plugin.qq-tts.speak 与 qq.audio.send。
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const manifest = {
  id: 'qq-tts', name: '发语音（TTS）', version: '1.0.1', bundled: true,
  description: '把文字合成为语音并以 QQ 语音消息发出：默认用本机 Windows 语音离线合成，也支持硅基流动 CosyVoice 等网络 TTS。',
  dependencies: { framework: '>=0.9.0' }, configVersion: 1,
  capabilities: ['actions', 'resources', 'storage'],
  configSchema: {
    provider: {
      type: 'string', title: '语音来源', enum: ['local', 'siliconflow', 'custom'], default: 'local',
      description: 'local：本机 Windows 系统语音，离线、无需密钥；siliconflow：硅基流动 CosyVoice；custom：兼容 OpenAI /v1/audio/speech 的自建服务（可指向本机端口）。'
    },
    localVoice: {
      type: 'string', title: '本地音色', default: 'Microsoft Huihui Desktop', maxLength: 120,
      description: 'Windows 已安装语音的完整名称；中文系统通常为 Microsoft Huihui Desktop。'
    },
    localRate: { type: 'number', title: '本地语速', default: 0, min: -10, max: 10, integer: true, description: 'Windows 语音的语速，-10 最慢，10 最快。' },
    localVolume: { type: 'number', title: '本地音量', default: 100, min: 0, max: 100, integer: true },
    powershellPath: { type: 'string', title: 'PowerShell 路径', default: 'powershell.exe', maxLength: 260, description: '本地语音通过 Windows PowerShell 调用系统语音；默认从 PATH 查找。' },
    ffmpegPath: { type: 'string', title: 'ffmpeg 路径', default: 'ffmpeg', maxLength: 260, description: '本地语音生成的 WAV 需要 ffmpeg 转成 MP3；默认从 PATH 查找。' },
    maxSeconds: { type: 'number', title: '本地语音最长秒数', default: 60, min: 5, max: 300, integer: true },
    apiUrl: { type: 'string', title: '网络语音地址', default: 'https://api.siliconflow.cn/v1/audio/speech', maxLength: 300, description: 'siliconflow 默认使用硅基流动官方地址；custom 填自己的 /v1/audio/speech 地址。' },
    model: { type: 'string', title: '网络模型', default: 'FunAudioLLM/CosyVoice2-0.5B', maxLength: 120 },
    netVoice: { type: 'string', title: '网络音色', default: 'FunAudioLLM/CosyVoice2-0.5B:alex', maxLength: 120, description: '硅基流动的音色形如 FunAudioLLM/CosyVoice2-0.5B:alex，也支持 anna、bella 等。' },
    apiKey: { type: 'string', title: '网络语音密钥', default: '', maxLength: 300, description: '留空则读取环境变量 SILICONFLOW_API_KEY（custom 读取 TTS_API_KEY）。填写后会保存在本机状态文件中。' },
    speed: { type: 'number', title: '网络语速', default: 1, min: 0.25, max: 4, description: '仅网络来源有效，1 为原速。' },
    maxChars: { type: 'number', title: '单条最多字数', default: 200, min: 20, max: 500, integer: true, description: '超过的字数会被拒绝，而不是截断。' },
    cooldownSec: { type: 'number', title: '同一聊天冷却（秒）', default: 5, min: 0, max: 600, integer: true }
  },
  settings: {
    title: '发语音（TTS）',
    description: '把文字合成为语音发到当前聊天。本地语音离线运行，依赖 Windows 内置语音和 ffmpeg；网络语音会把朗读文字发送到你配置的 TTS 服务。动作默认停用，需要主人在“主人与权限”里启用 plugin.qq-tts.speak 和 qq.audio.send。',
    sections: [
      { title: '语音来源', fields: ['provider'] },
      { title: '本地语音（Windows）', fields: ['localVoice', 'localRate', 'localVolume', 'maxSeconds', 'powershellPath', 'ffmpegPath'] },
      { title: '网络语音（硅基流动等）', fields: ['apiUrl', 'model', 'netVoice', 'apiKey', 'speed'] },
      { title: '使用限制', fields: ['maxChars', 'cooldownSec'] }
    ]
  }
};

const MAX_AUDIO = 8 * 1024 * 1024;
const LOCAL_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$TextPath,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [Parameter(Mandatory=$true)][string]$ErrorFile,
  [string]$VoiceName = '',
  [int]$Rate = 0,
  [int]$Volume = 100
)
$ErrorActionPreference = 'Stop'
$debug = $OutFile + '.debug'
$stream = $null
try {
  Add-Content -Path $debug -Value 'start' -Encoding UTF8
  $text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($text)) { throw '语音文本为空' }
  $voice = New-Object -ComObject SAPI.SpVoice
  if ($VoiceName) {
    $voices = $voice.GetVoices()
    $selected = $null
    for ($i = 0; $i -lt $voices.Count; $i++) {
      $description = $voices.Item($i).GetDescription()
      if ($description -eq $VoiceName -or $description -like ($VoiceName + ' -*')) { $selected = $voices.Item($i); break }
    }
    if (-not $selected) {
      $names = @()
      for ($i = 0; $i -lt $voices.Count; $i++) { $names += $voices.Item($i).GetDescription() }
      throw ('未安装音色「' + $VoiceName + '」，可用音色：' + ($names -join '、'))
    }
    $voice.Voice = $selected
    Add-Content -Path $debug -Value 'voice-selected' -Encoding UTF8
  }
  $voice.Rate = $Rate
  $voice.Volume = $Volume
  $stream = New-Object -ComObject SAPI.SpMemoryStream
  $voice.AudioOutputStream = $stream
  Add-Content -Path $debug -Value 'output-set' -Encoding UTF8
  $voice.Speak($text)
  $bytes = $stream.GetData()
  [System.IO.File]::WriteAllBytes($OutFile, $bytes)
  Add-Content -Path $debug -Value ('spoken; bytes=' + $bytes.Length) -Encoding UTF8
} catch {
  Add-Content -Path $debug -Value ('error: ' + $_.Exception.Message) -Encoding UTF8
  try { [System.IO.File]::WriteAllText($ErrorFile, $_.Exception.Message, (New-Object System.Text.UTF8Encoding($false))) } catch {}
  exit 1
} finally {
  if ($stream) { try { $stream.Close() } catch {} }
}`;

const PROVIDER_LABEL = { local: '本机 Windows 语音', siliconflow: '硅基流动', custom: '自建网络语音' };

export function defaultConfig() {
  return Object.fromEntries(Object.entries(manifest.configSchema).map(([key, field]) => [key, structuredClone(field.default)]));
}

export function speechPayload(text, config, voice = '') {
  return {
    model: String(config.model || ''), input: text, voice: String(voice || config.netVoice || ''),
    response_format: 'mp3', speed: Number(config.speed) || 1, stream: false
  };
}

// 运行一个子进程并收集 stderr；超时、取消或非零退出都转成可读错误。
export function runProcess(command, args, { timeoutMs = 15000, signal, label = command } = {}) {
  return new Promise((resolve, reject) => {
    let child, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(new Error(label + '超时')); }, timeoutMs);
    const onAbort = () => { try { child?.kill(); } catch {} finish(Object.assign(new Error(label + '已取消'), { code: 'PLUGIN_CANCELLED' })); };
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      return finish(new Error('无法运行 ' + label + '：' + String(error?.message || error).slice(0, 160)));
    }
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', error => finish(new Error('无法运行 ' + label + '：' + String(error?.message || error).slice(0, 160))));
    child.on('close', code => {
      if (code === 0) return finish(null, { stderr });
      const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 220);
      finish(new Error(label + '失败' + (detail ? '：' + detail : '（退出码 ' + code + '）')));
    });
  });
}

export function wavSeconds(bytes) {
  const data = Math.max(0, bytes - 44);
  return Math.round((data / (24000 * 2)) * 10) / 10;
}

function wrapPcmAsWav(pcm, sampleRate = 22050, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * bits / 8;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function synthesizeLocal(text, config, { signal, voice, run = runProcess } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qq-tts-'));
  const textFile = path.join(dir, 'text.txt'), wavFile = path.join(dir, 'voice.wav'),
    mp3File = path.join(dir, 'voice.mp3'), errorFile = path.join(dir, 'error.txt'), scriptFile = path.join(dir, 'speak.ps1');
  try {
    await writeFile(textFile, text, { encoding: 'utf8', mode: 0o600 });
    // Windows PowerShell 5.1 只有看到 BOM 才按 UTF-8 读取脚本，避免中文错误提示乱码。
    await writeFile(scriptFile, Buffer.from('\uFEFF' + LOCAL_SCRIPT, 'utf8'), { mode: 0o600 });
    const selected = String(voice || config.localVoice || '').trim();
    const rate = Number.isInteger(config.localRate) ? config.localRate : 0;
    const volume = Number.isInteger(config.localVolume) ? config.localVolume : 100;
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
      '-TextPath', textFile, '-OutFile', wavFile, '-ErrorFile', errorFile, '-Rate', String(rate), '-Volume', String(volume)];
    if (selected) args.push('-VoiceName', selected);
    let runResult;
    try {
      runResult = await run(String(config.powershellPath || 'powershell.exe'), args, { timeoutMs: 12000, signal, label: '本地语音合成' });
    } catch (error) {
      if (signal?.aborted || error.code === 'PLUGIN_CANCELLED') throw error;
      // PowerShell 5.1 的中文错误经 stderr 会乱码；脚本另外写了 UTF-8 错误文件。
      const detail = await readFile(errorFile, 'utf8').catch(() => '');
      throw detail.trim() ? new Error(detail.trim().slice(0, 220)) : error;
    }
    let wav = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      wav = await stat(wavFile).catch(() => null);
      if (wav && wav.size >= 100) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 120));
    }
    if (!wav || wav.size < 100) {
      const detail = await readFile(errorFile, 'utf8').catch(() => '');
      const size = wav?.size ?? 0;
      throw new Error(String(detail).trim().slice(0, 220) || String(runResult?.stderr || '').trim().slice(0, 220) || ('本地语音没有生成音频数据（WAV ' + size + ' 字节）；宿主进程可能需要桌面/音频会话，真实 QQ TTS 未完成'));
    }
    let wavBytes = await readFile(wavFile);
    if (wavBytes.subarray(0, 4).toString('ascii') !== 'RIFF') {
      wavBytes = wrapPcmAsWav(wavBytes);
      await writeFile(wavFile, wavBytes, {mode: 0o600});
      wav = {size: wavBytes.length};
    }
    const seconds = wavSeconds(wav.size);
    const maxSeconds = Math.min(300, Math.max(5, Number(config.maxSeconds) || 60));
    if (seconds > maxSeconds) throw new Error('本地语音超过 ' + maxSeconds + ' 秒上限，请缩短文字');
    await run(String(config.ffmpegPath || 'ffmpeg'), ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavFile,
      '-t', String(maxSeconds), '-codec:a', 'libmp3lame', '-b:a', '64k', '-ar', '24000', '-ac', '1', mp3File],
      { timeoutMs: 8000, signal, label: 'ffmpeg 转码' });
    const bytes = await readFile(mp3File).catch(() => null);
    if (!bytes?.length) throw new Error('ffmpeg 没有生成 MP3 文件');
    if (bytes.length > MAX_AUDIO) throw new Error('语音文件超过 8 MB，请缩短文字');
    if (!isAudio(bytes)) throw new Error('ffmpeg 生成的文件不是可识别的音频');
    return { bytes, provider: 'local', voice: selected || '系统默认', seconds };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function synthesizeNetwork(text, config, { signal, voice, fetchImpl = globalThis.fetch } = {}) {
  const endpoint = String(config.apiUrl || '').trim();
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('网络语音地址无效，请填写完整的 http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('网络语音地址必须是 http(s) 且不能包含账号密码');
  const envName = config.provider === 'siliconflow' ? 'SILICONFLOW_API_KEY' : 'TTS_API_KEY';
  const key = String(config.apiKey || '').trim() || String(process.env[envName] || '').trim();
  if (!key) throw new Error('尚未填写网络语音密钥：请在设置页填写，或设置环境变量 ' + envName);
  const selected = String(voice || config.netVoice || '').trim();
  if (!selected) throw new Error('尚未选择网络音色');
  const deadline = AbortSignal.timeout(20000);
  const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: composed,
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'audio/*' },
      body: JSON.stringify(speechPayload(text, config, selected))
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('网络语音请求超时或已取消');
    throw new Error('网络语音请求失败：' + String(error?.message || error).replaceAll(key, '[凭据已隐藏]').slice(0, 200));
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).replaceAll(key, '[凭据已隐藏]').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error('网络语音请求失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''));
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_AUDIO) throw new Error('语音文件超过 8 MB，请缩短文字');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('网络语音没有返回音频');
  if (bytes.length > MAX_AUDIO) throw new Error('语音文件超过 8 MB，请缩短文字');
  if (!isAudio(bytes)) throw new Error('网络语音返回的内容不是音频');
  return { bytes, provider: config.provider, voice: selected, seconds: null };
}

export function synthesizeVoice(text, config, options = {}) {
  if (config.provider === 'local') return synthesizeLocal(text, config, options);
  if (config.provider === 'siliconflow' || config.provider === 'custom') return synthesizeNetwork(text, config, options);
  return Promise.reject(new Error('不支持的语音来源：' + String(config.provider)));
}

export function isAudio(bytes) {
  if (bytes.length < 4) return false;
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return true; // MP3
  if (bytes.subarray(0, 4).toString('latin1') === 'OggS') return true; // OGG/Opus
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE') return true;
  if (bytes.subarray(0, 5).toString('latin1') === '#!SILK') return true;
  if (bytes.subarray(0, 4).toString('latin1') === 'fLaC') return true;
  return false;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pointLength(text) {
  return Array.from(text).length;
}

async function remember(api, context, entry, log) {
  try {
    await api.storage.update(data => {
      const recent = Array.isArray(data.recent) ? data.recent : [];
      const now = Date.now();
      const cooldowns = data.cooldowns && typeof data.cooldowns === 'object' ? data.cooldowns : {};
      for (const key of Object.keys(cooldowns)) if (!(now - Number(cooldowns[key]) < 3600000)) delete cooldowns[key];
      if (entry.ok) cooldowns[context.key] = now;
      const chatKeys = Object.keys(cooldowns);
      if (chatKeys.length > 200) {
        chatKeys.sort((a, b) => Number(cooldowns[a]) - Number(cooldowns[b]));
        for (const key of chatKeys.slice(0, chatKeys.length - 200)) delete cooldowns[key];
      }
      const row = { t: now, provider: entry.provider, voice: entry.voice, chars: entry.chars, ms: entry.ms, ok: entry.ok === true };
      if (entry.outcome) row.outcome = String(entry.outcome).slice(0, 20);
      if (!entry.ok) row.error = String(entry.error || '').slice(0, 160);
      recent.unshift(row);
      return { schema: 1, cooldowns, recent: recent.slice(0, 20) };
    });
  } catch (error) {
    log?.('warn', '语音记录写入失败：' + error.message);
  }
}

export function activateTTS(framework, { synthesize = synthesizeVoice, log } = {}) {
  const api = framework.registerTrustedPackage(manifest);

  const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  api.action('speak', {
    description: '仅主人或已授权用户：把一段话合成为语音，作为 QQ 语音消息发到当前聊天。适合对方明确想听声音、要你“用语音说/念出来/唱一句”，或你想用声音回一句时。text 只放要朗读的纯文字（不要 Markdown、表情、动作描写或链接），一次一条；刚发过就不要重复发送。',
    mutating: true, timeoutMs: 30000,
    parameters: schema({
      text: { type: 'string', maxLength: 500, description: '要朗读的纯文字' },
      voice: { type: 'string', maxLength: 120, description: '可选：覆盖本次音色（本地为 Windows 语音名，网络为音色 ID）' }
    }, ['text'])
  }, async (args, context, signal) => {
    const config = api.getConfig();
    const text = cleanText(args.text);
    if (!text) api.reject('请提供要朗读的文字');
    const max = Math.min(500, Math.max(20, Number(config.maxChars) || 200));
    if (pointLength(text) > max) api.reject('一次最多 ' + max + ' 个字符的语音，请缩短或分条发送');

    const stored = api.storage.get();
    const last = Number(stored.cooldowns?.[context.key] || 0);
    const wait = Math.ceil(((Number(config.cooldownSec) || 0) * 1000 - (Date.now() - last)) / 1000);
    if (last && wait > 0) api.reject('语音冷却中，请 ' + wait + ' 秒后再发');

    const started = Date.now(), chars = pointLength(text);
    let result;
    try {
      result = await synthesize(text, config, { signal, voice: String(args.voice || '').trim(), log });
    } catch (error) {
      await remember(api, context, { ok: false, provider: config.provider, voice: '', chars, ms: Date.now() - started, error: error.message }, log);
      throw error;
    }
    if (signal.aborted) throw Object.assign(new Error('语音合成已取消'), { code: 'PLUGIN_CANCELLED' });

    const resource = await api.putResource(result.bytes, context, { purpose: 'audio', name: 'voice' });
    let sent;
    try {
      sent = await api.invoke('qq.audio.send', { resourceId: resource.id }, context, signal);
    } catch (error) {
      await remember(api, context, { ok: false, provider: result.provider, voice: result.voice, chars, ms: Date.now() - started, error: '发送失败：' + error.message }, log);
      throw new Error('语音已合成，但发送失败：' + String(error.message || error).slice(0, 180));
    }
    const outcome = sent?.outcome || 'unknown';
    const confirmed = outcome === 'confirmed';
    const accepted = outcome === 'accepted';
    await remember(api, context, { ok: confirmed, outcome, provider: result.provider, voice: result.voice, chars, ms: Date.now() - started, ...(confirmed ? {} : { error: '发送结果：' + outcome }) }, log);
    return {
      ok: confirmed, outcome, accepted, provider: PROVIDER_LABEL[result.provider] || result.provider, voice: result.voice,
      chars, seconds: result.seconds ?? null,
      instruction: confirmed ? '语音已经发出，不要重复发送同一段。' : accepted ? '网关已受理语音，但尚未确认送达；不要声称已经确认收到。' : '语音发送结果未确认，不要声称已经发出。'
    };
  });

  api.settings(manifest.settings, async query => {
    const config = api.getConfig(), stored = api.storage.get();
    const recent = Array.isArray(stored.recent) ? stored.recent : [];
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = recent.filter(row => Number(row.t) >= start.getTime());
    const failed = recent.filter(row => row.ok !== true);
    const offset = Number(query?.offset || 0);
    return {
      stats: [
        { label: '今日语音', value: today.length },
        { label: '最近失败', value: failed.length },
        { label: '当前来源', value: PROVIDER_LABEL[config.provider] || config.provider }
      ],
      columns: [{ key: 'time', label: '时间', format: 'datetime' }, { key: 'provider', label: '来源' }, { key: 'voice', label: '音色' }, { key: 'chars', label: '字数' }, { key: 'result', label: '结果' }, { key: 'ms', label: '耗时(ms)' }],
      rows: recent.slice(offset, offset + 30).map(row => ({
        time: new Date(row.t).toISOString(), provider: PROVIDER_LABEL[row.provider] || row.provider,
        voice: row.voice || '—', chars: row.chars,
        result: row.ok ? '已发送' : '失败：' + String(row.error || '未知原因'),
        ms: row.ms
      })),
      total: recent.length, offset, hasMore: offset + 30 < recent.length
    };
  });

  return api;
}
