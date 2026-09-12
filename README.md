# say-hook

A macOS CLI and Claude Code Stop hook that speaks text aloud using [ElevenLabs](https://elevenlabs.io) V3 Text-to-Speech, falling back to the system `say` command.

demo: https://screen.studio/share/sl41XjhC?state=uploading

## Install

```bash
mise use github:HikaruEgashira/say-hook
```

```claude
setup following instruction https://raw.githubusercontent.com/HikaruEgashira/say-hook/refs/heads/main/.claude/commands/say-hook-setup.md
```

## Configuration

Store your ElevenLabs API key in the macOS Keychain:

```bash
security add-generic-password -a "$USER" -s "elevenlabs-api-key" -W
```

Optional environment variables:

| Variable | Description |
|---|---|
| `ELEVENLABS_VOICE_ID` | Voice ID (default: Yui, `fUjY9K2nAIwlALOwSiwc`) |
| `ELEVENLABS_VOICE_NAME` | Expected voice name; `check` fails on an ID/name mismatch |
| `ELEVENLABS_SPEED` | Speech speed multiplier (default: `1.3`) |
| `SAY_MAX_CHARS` | Max characters sent to TTS (default and hard limit: `200`) |
| `SAY_MAX_SECONDS` | Max playback duration in seconds (default: `30`) |
| `SAY_VOLUME` | Playback volume, `0.0`–`1.0` (default: `0.5`) |

`SAY_VOLUME` applies to the ElevenLabs playback (`afplay`). The system
`say` fallback follows the macOS output volume instead.

The Stop hook speaks through the first `.`, `,`, or `。`, including that
delimiter, and never exceeds `SAY_MAX_CHARS`.

## Usage

```bash
say-hook "Hello, world!"
```

## Herdr plugin

[`herdr/`](herdr/) is a [Herdr](https://herdr.dev/) plugin that speaks an
agent's opening excerpt aloud when it reaches `done` or `blocked` — the
voice counterpart to a push notification when you run several agent panes in
parallel.

```bash
herdr plugin install HikaruEgashira/say-hook/herdr
```

See [herdr/README.md](herdr/README.md) for configuration.

## License

MIT
