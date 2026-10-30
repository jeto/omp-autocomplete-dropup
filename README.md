# omp-autocomplete-dropup

[![latest omp](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fjeto%2Fomp-autocomplete-dropup%2Fbadges%2Fomp.json)](https://github.com/jeto/omp-autocomplete-dropup/actions/workflows/compat.yml)

An [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) extension that shows the prompt autocomplete
dropdown (`/` commands, `@` files, …) **above** the input, drawn over the transcript like Claude Code
does. The input never moves while the list opens, narrows, grows or closes.

Stock omp renders the dropdown below the input and resizes it on every keystroke, so the input
bounces up and down while you type.

## Install

```sh
omp plugin install github:jeto/omp-autocomplete-dropup   # or gitlab:…, or a full git URL
```

Restart omp afterwards (`/restart` resumes the current session). Update with
`omp plugin upgrade omp-autocomplete-dropup`.

For local development, link a checkout instead: `omp plugin link /path/to/omp-autocomplete-dropup`.

## Settings

Change them in omp's plugin settings (`/settings` → plugins), with
`omp plugin config set omp-autocomplete-dropup <key> <value>` (`config list` shows them,
`config delete` restores a default), or (for `mode`) with the `/dropup` command.

| Setting | Values | Default | Effect |
|---|---|---|---|
| `mode` | `overlay`, `inline` | `overlay` | `overlay` draws the list over the transcript; `inline` inserts it above the input and pushes the transcript up |
| `scrollbackRestore` | `typing-pause`, `on-close` | `typing-pause` | When transcript rows the list uncovered in terminal scrollback are restored (see below) |
| `scrollbackRestoreDelayMs` | 0–2000 | `150` | Typing pause before a `typing-pause` restore |

`/dropup` toggles `mode`; `/dropup overlay` and `/dropup inline` set it. Settings edited outside
`/dropup` apply from the next time the list opens.

## How it works

The editor is replaced by a subclass that never adds the dropdown rows to omp's layout. After every
frame it writes the list directly onto the terminal rows above the input (cursor saved and
restored, inside a synchronized update), leaving one blank separator row above the list.

Anything omp draws below the input (a bottom status bar in the `claude`, `rule`, `pi`, … composer
shapes, extension `belowEditor` widgets) is measured each frame, so the box always ends directly
above the editor. Stock omp hides the bottom status bar while the dropdown is open, to make room
for it below the input; this extension keeps the bar visible unless the list really renders there,
so the input does not shift by a row.

When the list shrinks or closes, the rows it uncovered are restored:

- rows still in omp's live viewport: a viewport repaint, immediately;
- rows already in native terminal scrollback, which omp cannot repaint in place: a full history
  replay, the same one omp runs after a theme change. With `typing-pause` this runs once typing
  pauses for `scrollbackRestoreDelayMs`; with `on-close` only when the list closes, and uncovered
  rows stay blank until then.

When there is no room above the input (a short session in a small terminal), the list renders below
the input as stock omp does, growing into the empty rows there.

## Caveats

- **Relies on omp internals**: the dropdown rows being appended after the editor rows in
  `Editor.render()`, `Editor.debugChildren`, the composer mounting its rows as the TUI's children
  in screen order, `TUI.getMutableViewport()`, and the status line's `setAutocompleteActiveProbe`
  (reached via `Editor.composerFacts`). When one of these is missing the dropdown falls back to the
  stock layout; a changed meaning could misplace the box. The badge above shows whether the latest
  omp release still passes; CI checks it daily.
- **History replay** rewrites the whole transcript, which can be noticeable in very long sessions,
  and clears terminal scrollback from before omp started. Use `on-close` to replay at most once per
  list.
- Output streaming under an open list can briefly overwrite the box until the next frame repaints it.
- Only one extension can replace the prompt editor. If another one already did, this one stays off.

## Development

```sh
npm install --ignore-scripts   # omp packages, pinned to the last version tested locally
npm run typecheck              # tsc against omp's own types
omp plugin link .              # load this checkout into omp
npm run smoke                  # terminal smoke test; needs uv, the plugin linked, OMP_BIN to pick a binary
```

The smoke test (`test/smoke.py`) runs a real omp in a pseudo-terminal and fails when the input row
moves, the list renders below the input, rows below the input change, the box does not shrink with
the list, or the screen is not restored on close. It needs no model or login.

CI (`.github/workflows/compat.yml`) runs both checks against the latest omp release on every push
and daily, and publishes the result to the `badges` branch for the badge above.

## License

[MIT](LICENSE)
