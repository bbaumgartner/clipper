# Clipper

Local three-panel video editor for cutting large files quickly. Keyboard-first, minimal UI. ffmpeg does all media work; videos are never loaded whole into memory.

**Source → Clips → Video → Export.** Mark drafts in an overlay, apply to encode clips, arrange a sequence, export one file.

macOS desktop app (Electron). GPL-3.0 — commercial use is allowed if derivatives stay GPL and source is provided.

## Architecture

Electron window (web client) talks to a local REST server on `127.0.0.1`. The server owns the filesystem, SQLite state, and a serial ffmpeg queue.

```
Renderer  →  Fastify (127.0.0.1)  →  ffmpeg / SQLite
```

## Design

Three equal columns. Overlay player: video on top, filmstrip below (blue playhead, yellow draft marks). Cuts are drafts until Apply / Cmd+Enter / close; Esc discards.

| Key | Panels | Overlay |
| --- | --- | --- |
| 1 / 2 / 3 | Focus Source / Clips / Video | — |
| ↑ ↓ | Select | — |
| Enter | Open player | Cut (source) |
| Cmd+Enter | — | Apply drafts (source) |
| Space | — | Play / pause |
| ← → | Clips: send to video | Seek ±0.5s (Shift ±5s) |
| + | Source: add videos | — |
| Delete | Remove row / clip / sequence item | — |
| Esc | — | Close (source: discard) |
| Alt+↑↓ | Reorder sequence | — |

## Use

Needs Node.js 22 or newer (current LTS). ffmpeg binaries are bundled via npm.

```bash
npm install
npm run dev
```

Opens the Electron app. Add video files, Enter to play, Enter to mark cuts, Apply or Cmd+Enter to commit. Right arrow sends a clip to the video panel. Export concatenates the sequence (waits for encodes to finish).

State (sources, clips, sequence) is restored from SQLite in the app data dir. There are no named project files in v1.

## License

[GPL-3.0](LICENSE)
