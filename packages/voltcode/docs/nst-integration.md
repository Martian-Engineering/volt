# NST (Volt 0.1) Backend Integration

VoltCode can be configured to use the NST backend for inference and continual learning with per-repo models.

## Configuration

Add the following to your `voltcode.json` file:

```json
{
  "provider": {
    "br": {
      "options": {
        "baseURL": "https://your-nst-proxy-url.com",
        "apiKey": "your-api-key-here"
      }
    },
    "model": "br/volt-0.1"
  }
}
```

### Configuration Options

- **baseURL** (required): The URL of your NST reverse proxy (OpenAI-compatible)
- **apiKey** (required): Your API key for the NST backend
- **model** (optional): The default model to use, typically `br/volt-0.1`

## Features

### Per-Repo Initialization

When configured, VoltCode will send `x-voltcode-project` header (derived from git root commit) on all inference requests to the NST backend, enabling per-repo models.

### Initial Training

Run `/init` in the TUI to initialize training for the current repository:

1. VoltCode requests initialization from the NST backend
2. Backend creates an empty bare git repo
3. VoltCode performs `git push --mirror` to that remote
4. VoltCode polls training progress every 10 seconds
5. Progress is displayed in the footer: `Model: init 37%` / `Model: ready` / `Model: failed`

### Continual Learning

VoltCode automatically captures:

- **User prompts**: Sent via OpenAI-compatible API
- **Tool results**: Emitted after each tool completes (stdout, stderr, exit code)
- **Feedback**: Thumbs up/down sends feedback to backend
- **Remembered notes**: `/remember <text>` command stores information for the repo

### Status

The footer shows training status:

- `Model: init X%` - Training in progress
- `Model: ready` - Repo model is ready for inference
- `Model: failed` - Training failed (check `/status` for details)
- Nothing displayed - Backend not configured or repo not initialized

### Commands

| Command            | Description                                |
| ------------------ | ------------------------------------------ |
| `/init`            | Initialize training for current repository |
| `/remember <text>` | Remember information for the current repo  |
| `/status`          | View detailed system status                |

### Headers Sent to NST

All requests to the NST backend include these headers:

- `Authorization: Bearer <api-key>`
- `x-voltcode-project`: `<repo-id>` (derived from git root commit)
- `x-voltcode-session`: `<session-id>`
- `x-voltcode-client`: Client identifier
