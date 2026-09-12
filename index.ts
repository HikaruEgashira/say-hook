import { ElevenLabsClient } from "elevenlabs";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { maxSpeechChars, selectSpeechText, truncateSpeechText } from "./speech-text";
import { configuredVoice, describeVoice, voiceMatchesExpectation } from "./voice";

/** bun build --define で埋め込まれるバージョン文字列。未定義時は dev */
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
const SECURITY_BIN = "/usr/bin/security";
const AFPLAY_BIN = "/usr/bin/afplay";
const SYSTEM_SAY_BIN = "/usr/bin/say";

// Claude Code settings.json のスキーマ
// https://docs.anthropic.com/en/docs/claude-code/hooks

/** hooks[].matcher に一致したときに実行されるコマンド */
interface HookEntry {
  type: "command";
  command: string;
  async?: boolean;
}

/** イベント種別ごとのフック群。matcher で絞り込める */
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

/** ~/.claude/settings.json の既知フィールド */
interface ClaudeSettings {
  hooks?: {
    Stop?: HookGroup[];
    PreToolUse?: HookGroup[];
    PostToolUse?: HookGroup[];
    Notification?: HookGroup[];
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  env?: Record<string, string>;
}

/** Claude Code が Stop hook の stdin に渡す JSON */
interface StopHookInput {
  /** 二重発火防止フラグ: true のときはフック自身が発火元 */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}


function getApiKey(): string {
  const result = Bun.spawnSync([
    SECURITY_BIN, "find-generic-password",
    "-a", process.env.USER ?? "",
    "-s", "elevenlabs-api-key",
    "-w",
  ], { stderr: "pipe" });
  if (result.exitCode === 0) {
    return result.stdout.toString().trim();
  }
  console.error("Error: ElevenLabs API key not found in Keychain.\nRun: security add-generic-password -a \"$USER\" -s \"elevenlabs-api-key\" -W");
  process.exit(1);
}

const DEFAULT_MAX_SECONDS = 30;
const DEFAULT_VOLUME = 0.5;

/** afplay -v に渡す再生音量。範囲外・不正値は既定値に落とす。 */
function playbackVolume(value?: string): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_VOLUME;
}

function sayFallback(message: string): void {
  Bun.spawnSync([SYSTEM_SAY_BIN, message], { stderr: "pipe" });
}

async function extractErrorMessage(e: unknown): Promise<string> {
  let body = (e as { body?: unknown })?.body;
  if (body instanceof ReadableStream) {
    try {
      body = await new Response(body).json();
    } catch {
      body = undefined;
    }
  }
  if (body && typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === "object") {
      const status = (detail as { status?: unknown }).status;
      if (status === "quota_exceeded") return "ElevenLabs quota exceeded";
      if (typeof status === "string") return `ElevenLabs ${status.replace(/_/g, " ")}`;
    }
  }
  const statusCode = (e as { statusCode?: unknown }).statusCode;
  if (statusCode === 401) return "ElevenLabs authentication failed";
  return "ElevenLabs request failed";
}

async function speak(text: string): Promise<void> {
  const maxSeconds = process.env.SAY_MAX_SECONDS ? parseFloat(process.env.SAY_MAX_SECONDS) : DEFAULT_MAX_SECONDS;
  const truncated = truncateSpeechText(text, maxSpeechChars(process.env.SAY_MAX_CHARS));

  const apiKey = getApiKey();

  const voiceId = configuredVoice(process.env.ELEVENLABS_VOICE_ID, process.env.ELEVENLABS_VOICE_NAME).id;
  const client = new ElevenLabsClient({ apiKey });

  const speed = process.env.ELEVENLABS_SPEED ? parseFloat(process.env.ELEVENLABS_SPEED) : 1.3;

  let audioBuffer: Buffer;
  try {
    const audio = await client.textToSpeech.convert(voiceId, {
      text: truncated,
      model_id: "eleven_v3",
      output_format: "mp3_44100_128",
      voice_settings: { speed },
    });
    const chunks: Buffer[] = [];
    for await (const chunk of audio) {
      chunks.push(Buffer.from(chunk));
    }
    audioBuffer = Buffer.concat(chunks);
  } catch (e) {
    const msg = await extractErrorMessage(e);
    console.error(`${msg}; falling back to ${SYSTEM_SAY_BIN}`);
    sayFallback(truncated);
    return;
  }

  const outPath = join(tmpdir(), `say-hook-${Date.now()}.mp3`);
  await writeFile(outPath, audioBuffer);

  const proc = Bun.spawn([AFPLAY_BIN, "-v", String(playbackVolume(process.env.SAY_VOLUME)), outPath], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), maxSeconds * 1000);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
    await unlink(outPath).catch(() => {});
  }
}

async function check(): Promise<void> {
  type CheckResult = { label: string; ok: boolean; detail: string };
  const results: CheckResult[] = [];

  const keychainResult = Bun.spawnSync([
    SECURITY_BIN, "find-generic-password",
    "-a", process.env.USER ?? "",
    "-s", "elevenlabs-api-key",
    "-w",
  ], { stderr: "pipe" });
  const apiKey = keychainResult.stdout.toString().trim();
  const keychainOk = keychainResult.exitCode === 0 && apiKey.length > 0;
  results.push({
    label: "elevenlabs-api-key (Keychain)",
    ok: keychainOk,
    detail: keychainOk ? "found" : "not found",
  });

  const voiceConfig = configuredVoice(process.env.ELEVENLABS_VOICE_ID, process.env.ELEVENLABS_VOICE_NAME);
  if (keychainOk) {
    try {
      const client = new ElevenLabsClient({ apiKey });
      const voice = await client.voices.get(voiceConfig.id, undefined, { timeoutInSeconds: 5, maxRetries: 0 });
      const voiceMatches = voiceMatchesExpectation(voiceConfig, voice);
      results.push({
        label: "ElevenLabs voice",
        ok: voiceMatches,
        detail: describeVoice(voiceConfig, voice),
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      const reason = statusCode === 401 ? "authentication failed"
        : statusCode === 404 ? "not found"
          : (error as { name?: string }).name === "TimeoutError" ? "lookup timed out"
            : "lookup failed";
      results.push({ label: "ElevenLabs voice", ok: false, detail: `${reason} (${voiceConfig.id})` });
    }
  } else {
    results.push({ label: "ElevenLabs voice", ok: false, detail: `not checked (${voiceConfig.id})` });
  }

  const afplayOk = await Bun.file(AFPLAY_BIN).exists();
  results.push({
    label: "afplay (macOS)",
    ok: afplayOk,
    detail: afplayOk ? AFPLAY_BIN : "not found",
  });

  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.label}: ${r.detail}`);
  }

  process.exit(results.every((result) => result.ok) ? 0 : 1);
}

async function hookStop(): Promise<void> {
  const input = await Bun.stdin.text();
  let data: StopHookInput;
  try {
    data = JSON.parse(input) as StopHookInput;
  } catch {
    // stdinが不正なJSONの場合は発話せず正常終了
    process.exit(0);
  }

  if (data.stop_hook_active) process.exit(0);

  const text = selectSpeechText(data.last_assistant_message ?? "", maxSpeechChars(process.env.SAY_MAX_CHARS));
  if (!text) process.exit(0);

  await speak(text);
}

// say-hook として登録された HookEntry かを判定する
// 実行ファイルのパスは bun build や mise の構成で変わるため、任意のパスのバイナリを検出する
// 旧名 `say hook` のエントリも update/uninstall で扱えるよう両方にマッチさせる
function isSayHookCommand(cmd: string): boolean {
  return /(^|\/)say(-hook)?\s+hook(\s|$)/.test(cmd);
}

async function loadSettings(): Promise<{ settings: ClaudeSettings; path: string }> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const settingsText = await readFile(settingsPath, "utf-8").catch(() => null);
  if (settingsText === null) {
    console.error(`settings.json が読み込めませんでした: ${settingsPath}`);
    process.exit(1);
  }
  try {
    return { settings: JSON.parse(settingsText) as ClaudeSettings, path: settingsPath };
  } catch (e) {
    console.error(`settings.json のパースに失敗しました: ${e}`);
    process.exit(1);
  }
}

async function saveSettings(path: string, settings: ClaudeSettings): Promise<void> {
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ~/.claude/settings.json の Stop hooks に say-hook を追加する
async function hookInstall(): Promise<void> {
  const hookCommand = `${process.execPath} hook`;
  const { settings, path } = await loadSettings();
  const stopHooks: HookGroup[] = settings.hooks?.Stop ?? [];

  for (const group of stopHooks) {
    for (const h of group.hooks ?? []) {
      if (isSayHookCommand(h.command)) {
        console.log(`既にインストール済みです。更新するには: say-hook hook update`);
        return;
      }
    }
  }

  const newEntry: HookEntry = { type: "command", command: hookCommand, async: true };
  const firstGroup = stopHooks[0];
  if (firstGroup !== undefined) {
    (firstGroup.hooks ??= []).push(newEntry);
  } else {
    stopHooks.push({ hooks: [newEntry] });
  }

  settings.hooks = { ...settings.hooks, Stop: stopHooks };
  await saveSettings(path, settings);
  console.log(`インストール完了: ${hookCommand}`);
}

// 既存の say-hook エントリのコマンドを現在の実行ファイルパスに更新する
async function hookUpdate(): Promise<void> {
  const hookCommand = `${process.execPath} hook`;
  const { settings, path } = await loadSettings();
  const stopHooks: HookGroup[] = settings.hooks?.Stop ?? [];

  let count = 0;
  for (const group of stopHooks) {
    for (const h of group.hooks ?? []) {
      if (isSayHookCommand(h.command)) {
        h.command = hookCommand;
        count++;
      }
    }
  }

  if (count === 0) {
    console.error("say-hook の hook が見つかりませんでした。先に: say-hook hook install");
    process.exit(1);
  }

  settings.hooks = { ...settings.hooks, Stop: stopHooks };
  await saveSettings(path, settings);
  console.log(`更新完了 (${count}件): ${hookCommand}`);
}

// settings.json から say-hook エントリを全て削除する (旧名 say hook の残存も含む)
async function hookUninstall(): Promise<void> {
  const { settings, path } = await loadSettings();
  const stopHooks: HookGroup[] = settings.hooks?.Stop ?? [];

  let removed = 0;
  const cleanedGroups: HookGroup[] = [];
  for (const group of stopHooks) {
    const kept = (group.hooks ?? []).filter((h) => {
      if (isSayHookCommand(h.command)) {
        removed++;
        return false;
      }
      return true;
    });
    // hooks が空になった group は捨てる (matcher のみ残して意味がないため)
    if (kept.length > 0) {
      cleanedGroups.push({ ...group, hooks: kept });
    } else if (group.hooks === undefined) {
      cleanedGroups.push(group);
    }
  }

  if (removed === 0) {
    console.log("削除対象の say-hook はありませんでした");
    return;
  }

  if (cleanedGroups.length === 0) {
    const { Stop: _Stop, ...rest } = settings.hooks ?? {};
    settings.hooks = rest;
  } else {
    settings.hooks = { ...settings.hooks, Stop: cleanedGroups };
  }
  await saveSettings(path, settings);
  console.log(`アンインストール完了 (${removed}件削除)`);
}

const args = process.argv.slice(2);

if (args[0] === "version") {
  console.log(VERSION);
} else if (args[0] === "check") {
  await check();
} else if (args[0] === "hook" && args[1] === "install") {
  await hookInstall();
} else if (args[0] === "hook" && args[1] === "update") {
  await hookUpdate();
} else if (args[0] === "hook" && args[1] === "uninstall") {
  await hookUninstall();
} else if (args[0] === "hook") {
  await hookStop();
} else if (args[0] === "excerpt") {
  const input = args.length > 1 ? args.slice(1).join(" ") : await Bun.stdin.text();
  const text = selectSpeechText(input, maxSpeechChars(process.env.SAY_MAX_CHARS));
  if (text) console.log(text);
} else {
  const text = args.join(" ");
  if (!text) {
    console.error("Usage: say-hook <text>");
    console.error("       say-hook version");
    console.error("       say-hook check");
    console.error("       say-hook excerpt [text]");
    console.error("       say-hook hook install");
    console.error("       say-hook hook update");
    console.error("       say-hook hook uninstall");
    process.exit(1);
  }
  await speak(text);
}
