# gpt-image

Pi extension for GPT image generation using Pi's existing ChatGPT/Codex subscription login.

## Intent

- Uses `/login` credentials for `openai-codex`.
- Talks directly to the ChatGPT/Codex subscription backend used by pi.
- Uses the backend `image_generation` tool.
- Does **not** use `OPENAI_API_KEY`.
- Does **not** use OpenAI Platform billing.
- Does **not** use browser/web automation.

## Install

Global install:

```bash
pi install npm:pi-gpt-image
```

Project install:

```bash
pi install -l npm:pi-gpt-image
```

## Setup

Use Pi's normal login once if needed:

```text
/login
```

Select **ChatGPT Plus/Pro (Codex)**.

Then:

```text
/reload
/gpt-image
```

## Usage

Ask normally:

```text
create a square image of a tiny robot painting the pi logo
```

Or direct tool request:

```text
use gpt_image_generate to create a wide cyberpunk city wallpaper
```

Show artifacts for the current session only:

```text
/gpt-image list
```

Browse current-session saved images in a TUI carousel:

```text
/gpt-image list carousel
```

Keys: `←`/`→` or `h`/`l` switch images, `q`/`esc` closes.

Show project config plus allowed values:

```text
/gpt-image config
```

Edit project config in Pi's built-in editor:

```text
/gpt-image config edit
```

Other config commands:

```text
/gpt-image config reset
```

## Tool parameters

`gpt_image_generate` supports:

- `prompt` — required prompt text
- `size` — `auto`, exact backend size, or preset: `square`, `landscape`, `portrait`, `square-2k`, `landscape-2k`, `landscape-4k`, `portrait-4k`
- `quality` — `low`, `medium`, `high`, `auto`
- `outputFormat` — `png`, `jpeg`, `webp`
- `parentId` — optional previous artifact id to record a parent relationship; previous image bytes are not sent automatically

Saved files and metadata are session-local:

- `outputDir: "project"` → `.pi/gpt-image/<session-id>/`
- `outputDir: "~/Projects/gpt-images"` → `~/Projects/gpt-images/<session-id>/`
- metadata manifest → `<outputDir>/<session-id>/manifest.json`

If a custom `outputDir` does not exist, `/gpt-image config` asks whether to create it or lets you correct the path before saving. Generation itself never creates missing custom base directories; it fails fast before any image request.

Size presets:

- `auto` → backend chooses
- `square` → `1024x1024`
- `landscape` → `1536x1024`
- `portrait` → `1024x1536`
- `square-2k` → `2048x2048`
- `landscape-2k` → `2048x1152`
- `landscape-4k` → `3840x2160`
- `portrait-4k` → `2160x3840`

## Config

Show `.pi/gpt-image/config.json` in the project:

```text
/gpt-image config
```

Edit it:

```text
/gpt-image config edit
```

Or create `~/.pi/agent/gpt-image/config.json` globally.

Project config overrides global config. Tool-call parameters override config defaults.

Configurable generation defaults:

```json
{
  "outputDir": "project",
  "size": "auto",
  "quality": "auto",
  "outputFormat": "png"
}
```

See `config.example.json`.

## Notes

This relies on ChatGPT/Codex subscription backend behavior. It is not the OpenAI Platform Images API. If the backend changes or your account/model lacks image generation, the tool will fail with an explanatory error.
