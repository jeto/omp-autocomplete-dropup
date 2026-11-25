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

Needs omp **19.2** or newer, which rebuilt the terminal UI. For omp 18.x, install v0.1.0:
`omp plugin install github:jeto/omp-autocomplete-dropup#v0.1.0`.

For local development, link a checkout instead: `omp plugin link /path/to/omp-autocomplete-dropup`.

## Settings

Change them in omp's plugin settings (`/settings` → plugins), with
`omp plugin config set omp-autocomplete-dropup <key> <value>` (`config list` shows them,
`config delete` restores a default), or (for `mode`) with the `/dropup` command.

| Setting | Values | Default | Effect |
|---|---|---|---|
| `mode` | `overlay`, `inline` | `overlay` | `overlay` draws the list over the transcript; `inline` inserts it above the input and pushes the transcript up |

`/dropup` toggles `mode`; `/dropup overlay` and `/dropup inline` set it. Settings edited outside
`/dropup` apply from the next time the list opens.

## How it works

omp paints the dropdown as rows appended below the composer that draw over the transcript; the
layout then slides the transcript and the composer up by the list's height. This extension wraps
omp's composer painter so the list rows never enter the layout, and wraps the terminal frame
writer so that, just before each frame is written, the list rows replace the viewport rows directly
above the input, with one blank separator row on top.

Because the list is part of the frame omp diffs, omp itself repaints the transcript rows the list
uncovers when it shrinks or closes. Nothing is written to the terminal behind omp's back.

Stock omp also hides the bottom status bar (`claude`, `rule`, `pi`, … composer shapes) while the
dropdown is open, which moves the input down a row. The extension keeps the bar in place.

When fewer rows than the list fit above the input (a short session in a small terminal), the list
shows a window around the selected item. With under three rows of room, it renders below the input
as stock omp does.

## Caveats

- **Relies on omp internals**: the composer's `col` `omp.editor` painter returning the list as
  trailing `covering` rows, the status panel's `col` `omp.status.panel` painter and its
  `placement.autocomplete` flag, and `FrameWriter.present` receiving each frame with the caret in
  viewport coordinates. When the composer painter is missing the dropdown renders stock; a changed
  meaning could misplace the box. The badge above shows whether the latest omp release still
  passes; CI checks it daily.
- Clicking a list item is untested: stock omp does not select an item on click in the smoke test's
  terminal emulator either.

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
