# pi-hostname-footer

A [pi](https://pi.dev) extension that replaces the default footer with a richer one: a colored hostname prefix, full token/cost/context-window stats, model + thinking level, and an extension status line.

## Why

When running pi across multiple machines (or many sessions), it's easy to lose track of which host you're on. This prepends a colored hostname to the working-directory line so each box is visually distinct at a glance. It also surfaces cache read/write and a context-window percentage with warning/error coloring as usage climbs.

## Behavior

The footer renders three lines:

1. `<hostname>@ <pwd> (git-branch) • <session-name>` — hostname colored by a stable hash of the name (each host always gets the same color). PWD collapses `$HOME` to `~`.
2. Stats line — cumulative across the whole session branch:
   - `↑<input>` / `↓<output>` tokens
   - `R<cache-read>` / `W<cache-write>` tokens
   - `$<cost>` (total)
   - `<percent>%/<context-window> (auto)` — turns warning-colored above 70% and error-colored above 90%
   - Right-aligned: model id (with `(provider)` prefix when multiple providers are available) and thinking level if the model supports reasoning.
3. Extension statuses — joined, sorted, single-line.

The hostname palette is a fixed set of 12 colors; each hostname is mapped to one via a stable string hash, so the same host always renders the same color.

If the session is stale (exiting/reloading), the footer degrades to a minimal "Session ending..." line instead of throwing.

## Install

```bash
pi install git:github.com/keen99/pi-hostname-footer
```

## License

MIT
