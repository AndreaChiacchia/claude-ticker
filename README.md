# Claude-Ticker

![version](https://img.shields.io/badge/version-0.3.0-blue)

A mod for the Claude Code CLI that draws a live cost row under the prompt, below the [claudepeeker](https://github.com/AndreaChiacchia/claude-peeker) status line and the claudespotter subagent rows. It shows what each turn spends (tokens in and out, and cost) while it runs, colored against the rest of the session, so you can see which prompts are expensive. Claudepeeker shows the overall limits; this shows each turn.

```
╭──────────────────────────────────────────────────────────────────────────────────────╮
│ >                                                                                    │
╰──────────────────────────────────────────────────────────────────────────────────────╯
  ? for shortcuts
  [Opus 5.5 ·high] · mods/main · ctx (1M) ▰▰▱▱▱ 29% · 5h (2h13m) █░░░░ 10% · wk (6d17h) █░░░░ 1%

  Σ $3.21 │ ● FIX │ ███████████████████░░░░░░░ │ $0.42 ▲0.31 │ 312K↓ 2.1K↑   ‹Edit›
  Σ $3.21 │ ● FIX │ ▁▁▁▁▃▂▅█ │ $0.42 ▲0.31 │ 312K↓ 2.1K↑
  Σ $3.21 │ ● EXPLAI │ FIX 13% ▏TESTS 4% ▏EXPLAI 9% │ $0.05 ▼0.37 │ 10K↓ 500↑
```

The three rows at the bottom are the same session in the three styles: the meter, the chart and the strip. Every style has the same order: the session total, the name of the turn, the bar (or chart, or strip), the cost and change, the token counts, each part set off by a dim `│`. In the strip the blocks are colored backgrounds, one per turn, each as wide as its share of the last 8 turns by default (setting `stripTurns`: 4 to 24, the running one included), touching, each one after the first starting with a thin line. The pulsing `●` is only in the label before the turn name; the bars and blocks carry no dot. When the row shows an earlier turn whose background helper is still working, a lavender `↻` takes the place of the dot. A blank line separates the row from the lines above it (setting `gapAbove`).

## Features

- **Three styles** (setting `style`):
  - **meter** (the default): a bar in the claudepeeker Blocks look (`█` filled, `░` empty, no background) that fills while the turn runs, on a fixed dollar scale: about $0.01 is the smallest step and $2 or more is full, each step up about twice the cost. A turn of $0.05 fills about a third of the bar, $0.30 about two thirds, $1.20 nearly all of it.
  - **chart**: one small bar per recent turn, 16 bars by default (setting `chartBars`: 4 to 32; fewer when the window is narrow), its height the cost on the same fixed dollar scale, newest at the right; the running turn grows in place, and a pricier turn never changes the other bars. Legend: `▁ $0.01  ▃ $0.05  ▅ $0.25  ▇ $1  █ $2+`.
  - **strip**: the last 8 turns by default (setting `stripTurns`: 4 to 24; the running one included) side by side, each block as wide as its share of them, colored on the same teal scale, the blocks touching with a thin dark line at the left edge of each one after the first. The % in a block is its share of the turns shown. The turn's name and share sit inside the block where they fit (setting `stripLabels` turns the text off). Older turns are in the `/ticker` table. When a turn starts, the oldest block shrinks away and the lavender live block appears; when a turn ends nothing empties, its block stays and blends to teal.
- **Five effects**, each on or off (all on by default):
  - `reacts`: the row moves on every step of a turn. Each tool call flashes its name at the right edge and bumps the bar, and the live marker pulses.
  - `stock`: costs and the token counts roll like an odometer. The Σ and cost digits that change flash (green going up, red going down); the token counts step toward their new value like the claudespotter token figure, their changed digits flashing (warm white going up, ice blue going down). The ▲/▼ change switches at once.
  - `celebrate`: a cheap, well-cached turn sparkles green, and a new session high pulses red (`‼ NEW HIGH ‼`).
  - `shimmer`: while Claude streams a response, the current turn shimmers: a light sweep runs over the filled part of the meter and over the live block of the strip, and the live bar of the chart pulses.
  - `grow`: smooth changes. The meter bar, the chart bars and the strip blocks ease to their new size and color in about 0.4 s instead of jumping.
- **One figure set per turn, in every style:** `FIX │ <bar> │ $0.42 ▲0.31 │ 312K↓ 2.1K↑`, with dim `│` dividers between the name, the visual, the cost and change, and the tokens.
  - `FIX` names the turn.
  - `$0.42` is its cost.
  - `▲0.31` (red) means $0.31 pricier than the turn before; `▼` (green) means cheaper; `=0.00` (gray) means about the same. The session's first turn has none.
  - `312K↓` is the input tokens, cache reads and writes included. `2.1K↑` is the output tokens. A turn starts at `0↓ 0↑` in dim gray until usage arrives.
  - The token figures are plain gray, with no background. The share of the input served from the prompt cache is in the `/ticker` table, and beside the input figure as `(94%c)` with the setting `cachePercent`.
- **The name of a turn:** the first word of your prompt that says something, in capitals and cut to 6 letters (`please refactor the parser` is `REFACT`). A slash command shows as `/IWO`.
- **A live entry:** the turn that is running starts with a pulsing `●` and counts up as it goes, in lavender.
- **Σ at the left edge:** the session total, exactly as `/cost` shows it.
- **A teal scale:** the meter bar, the chart bars and the strip blocks run from dim teal (a cheap turn for this session) to bright teal (a pricey one), measured against the session median from the fourth turn on (gray before). Names and costs of finished turns keep the default text color. The running turn is lavender. `▲` is red and `▼` green, as before.
- **Smooth changes:** bars, chart columns and strip blocks ease to their new size and color, and the `(94%c)` cache percent to its new value, in about 0.4 s (setting `grow`).
- **A table** (`/ticker`): this session turn by turn with a teal swatch column (a turn whose background helper is still working shows `↻`), the priciest turn, and two all-time lists. The top 10 priciest turns each end with their session total, `project/branch` and session title; the top 10 priciest sessions list total, turns, start date, `project/branch` and title. The title is Claude Code's own session title when the session has one at start or resume, otherwise the session's first prompt. The branch needs git; without it only the project folder shows.
- **Background helpers are credited to their turn:** a subagent launched in turn #71 keeps adding its tokens and cost to #71 after #71 ended, response by response, until it finishes, also when a message (SendMessage) resumes it during a later turn.
- **The row follows the active turn:** a running turn always has the row. When none runs and a background helper is still working on a finished turn, the row shows that turn: `↻` in lavender before its name, its number when it is not the newest (`↻ #71 FIX`), its cost, change, tokens and bar climbing with each helper response, its chart bar or strip block lavender. When several helpers work, the turn whose helper answered last. The row stays at least 2 s on a turn (a turn that just finished keeps its final figures for 2 s) and settles on the newest turn when everything is done.

  `Σ $3.41 │ ↻ #71 FIX │ ████████████████░░░░ │ $0.80 ▲0.38 │ 1.2M↓ 8.4K↑`
- **Saved per session:** `claude --resume` and `claude --continue` bring the tape back. The 20 latest sessions are kept.
- **A toast on a new high** (setting `newHighToast`): when a turn costs more than every earlier turn of the session, from the fourth turn on.
- **Display settings:** `label`, `change`, `tokens` and `cachePercent` change how each turn reads (see Settings).

## Install

**Claude Code CLI only.** You also need Claude Code 2.1.299 or later. The desktop app draws the row without motion.

Load it in every session by adding the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (separate several folders with `;` on Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\projects\\mods\\claudeticker;C:\\Users\\<you>\\projects\\mods\\claudehopper;C:\\Users\\<you>\\projects\\mods\\claudepeeker;C:\\Users\\<you>\\projects\\mods\\claudespotter;C:\\Users\\<you>\\projects\\mods\\claude-code-filetree"
  }
}
```

Or load it for a single session with `claude --plugin-dir <path to this folder>`.

**Order matters: list claudeticker first.** Mods earlier in the list sit outer in the hook chain, and only the outermost of the three is guaranteed to draw last. With claudeticker first, the order under the prompt is always the hint line, the claudepeeker line, the claudespotter rows while subagents run, then the ticker row. Listed after claudespotter, the row can appear above the subagent rows while subagents run.

## Usage

| Command | What it does |
|---|---|
| `/ticker` | Open the table: this session's turns, the priciest one, the all-time top 10 |
| `/ticker clear` | Empty this session's tape. The all-time records are kept, and Σ keeps matching `/cost` |

## Settings

Set them in `/config`, or in settings under `pluginConfigs.claudeticker`. A change applies at once, to the turns already shown too. They change the row only; the `/ticker` table keeps its columns.

| Setting | Values (default first) | Example |
|---|---|---|
| `style` | `meter`, `chart`, `strip` | a filling bar on a fixed dollar scale (full at $2) / a bar per turn / blocks sized by cost |
| `stripLabels` | `on`, `off` | ` FIX 13%` inside the strip blocks / plain colored blocks |
| `stripTurns` | `8`, any whole number from `4` to `24` | how many recent turns the strip shows |
| `chartBars` | `16`, any whole number from `4` to `32` | how many bars the chart shows, one per recent turn |
| `reacts` | `on`, `off` | the tool name flashes at the edge: `‹Edit›` |
| `stock` | `on`, `off` | `$0.38` rolls to `$0.39`, `$0.40` with the changed digits flashing; token counts roll too, their changed digits flashing |
| `celebrate` | `on`, `off` | `‼ NEW HIGH ‼` and the green sparkle |
| `shimmer` | `on`, `off` | a light sweep over the current turn while Claude streams |
| `grow` | `on`, `off` | bars and blocks ease to their new size / jump |
| `gapAbove` | `on`, `off` | one blank line above the row / the row right under the lines above |
| `newHighToast` | `off`, `on` | `Claude-Ticker: new session high $0.50 · FIX "fix the login bug"` |
| `label` | `symbol`, `prompt`, `number`, `numbered` | `FIX` / `#7 "fix the login…"` / `#7` / `#7 FIX` (number and symbol) (a turn shown while its helper works: `↻ #7 FIX`, always with its number when it is not the newest) |
| `change` | `dollars`, `percent`, `off` | `▲0.31` / `▲282%` / hidden |
| `tokens` | `compact`, `labeled` | `312K↓ 2.1K↑` / `312K in · 2.1K out` |
| `cachePercent` | `off`, `on` | hidden / `312K↓ (94%c) 2.1K↑`, or `312K in (94% cached) · 2.1K out` when labeled: the cached share as a number after the input figure (nothing before the turn has usage) |

All together: `label=prompt`, `change=percent`, `tokens=labeled` gives `#7 "fix the login bug" │ <bar> │ $0.42 ▲282% │ 312K in · 2.1K out`. The strip always names its blocks with the symbol, also with `label=numbered`; `label` shapes the name before the bar.

All five effects off gives a still row that still updates after every response.

On a narrow window the visual (the bar, the chart columns, the strip) shrinks first. Then the row drops its extras in this order, the same in every style: the badge, the token counts (with their divider, and the `(94%c)` note with them), the ▲ change, then the label (with its divider, so the bar then follows the Σ directly). A divider never doubles or dangles. The cost stays. Under 20 columns the row is not drawn.

## How it works

- **Tokens:** from the usage of each response. The tokens of every subagent that answers while the turn runs are added to it.
- **Cost:** the Claude Code session ledger, the same total `/cost` and the status line show, read after every model response (main and subagents), so a turn's figure grows while it runs. No price table is kept in the mod.
- **Σ:** that ledger itself, kept current between turns too.
- **Painting:** the row is one cell grid, repainted in place 10 times a second while Claude works or an effect is settling. Nothing is repainted while idle.
- **Shimmer:** the current turn shimmers while a response streams (every text, thinking or tool chunk keeps it going for half a second). A finished turn shimmers while its background helper works.
- **Background helpers:** the mod sees which turn launched each subagent, so its later responses are credited to that turn: tokens from each response's usage, cost from the growth of the session ledger around the response. The saved tape, the all-time records and the summary follow.
- **Which turn the row shows:** the running turn; else a finished turn whose background helper is still working (the one that answered last); else the newest turn. The row stays at least 2 s on a turn before it switches, except when a turn starts. On the desktop, and with all five effects off, it switches at the next update.
- **Summaries:** the mod keeps a small summary per session (total, turns, project, branch, title) for the all-time lists; the 10 priciest sessions, and the sessions of the 10 priciest turns, are kept beyond the 20 saved tapes.
- **Storage:** the mod's own store keeps the tape of the 20 latest sessions and the top 10 records.

## Limitations

- **Cost on a subscription** is the API list-price equivalent, not a bill.
- **Spend is attributed to the turn that started it.** A background helper's spend goes to the turn that launched it, as it happens, even after that turn ended and when a later turn resumes it. Spend no turn or helper can be tied to (side calls between responses, agents the mod did not see start) is only in Σ, and the `/ticker` table shows it as "Outside listed turns".
- **Precision:** the ledger has no per-response breakdown, so a response's cost is the ledger growth since the last reading. Two responses landing at the same moment (a background helper and the main turn, or two helpers) can swap a little cost between them. Each turn's tokens are exact.
- **A focused turn older than the strip or chart window** shows only in the figures and the label while its helper works; the strip keeps the last turns in order.
- **The desktop app** draws the row without motion.
- **The cost moves once per model response**, not per token. Between responses the motion comes from the shimmer, the live marker and the bumps.
- **No collapse.** The hint row cannot be collapsed; turn the five effects off for a still row.
- **A session resumed under a new id** starts a fresh tape.
- **A turn interrupted before any response** adds no entry.

## Development

```
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p .
```

| Path | Contents |
|---|---|
| `hooks/register.tsx` | the mod: the hooks, the row and its timer, the `/ticker` table and command, the turn and ledger tracking |
| `hooks/format.ts` | figures: cost, change, tokens, cache hit, turn names |
| `hooks/cells.ts` | colors, glyphs, the cell encoding |
| `hooks/anim.ts` | the animation state: odometers (costs and tokens), badges, shimmer clock, easing |
| `hooks/row.ts` | the three styles and the width rules |
| `hooks/history.ts` | the saved sessions, the all-time records and the session summaries |
| `types/index.d.ts` | the mod's state contract |
| `tests/` | tests for the figures, the row and the animation, the settings and the table |

## License

MIT, see [LICENSE](LICENSE).
