# Wright Gantt Calendar

A Gantt chart for Obsidian that reads dates out of your note frontmatter.

Built to be auditable rather than featureful. Three files, no dependencies, no build step, and no network code — you can read the whole thing in one sitting and know what it does. Bars are draggable, and rows have done and edit controls, so the chart writes back to your notes; see [Editing](#editing) for exactly what it touches.

## Install

There is no build step. Copy the plugin folder into your vault:

```
<your vault>/.obsidian/plugins/wright-gantt-calendar/
├── main.js
├── manifest.json
└── styles.css
```

Then enable it in **Settings → Community plugins**.

To verify what you installed before enabling it, read `main.js` top to bottom. It is around 1,820 lines, commented, and written in plain JavaScript rather than bundled output.

## Usage

Two ways in.

**The ribbon icon.** A calendar icon appears in the left ribbon once the plugin is enabled. It opens a Gantt as a full-width tab, with dropdowns for folder, scale, sort and grouping, and a **Hide finished** checkbox. Your selections are remembered. The same thing is on the command palette as **Open Gantt calendar**.

Proposed, active and finished items all appear on one chart by default. Grouping by **Status** separates them into bands while keeping everything in view; **Hide finished** is the opt-out when completed work starts crowding the chart.

**A code block**, for a chart embedded in a specific note:

````markdown
```gantt
title: Project Timeline
folder: 03_Projects
scale: week
sort: start
```
````

By default it charts every note under that folder with a `start_date` or `due_date` in its frontmatter:

```yaml
---
type: project
status: active
start_date: 2026-09-03
due_date: 2026-12-19
---
```

A note with only one date renders as a milestone diamond rather than a zero-width bar.

There is also an **Insert Gantt block** command if you would rather not type the fence.

> A code block only renders in Reading view or Live Preview. In Source mode you see the raw fence, which looks like the plugin is doing nothing.

### If the chart is empty

A field that exists but is blank does not count — `due_date:` with nothing after it is not a date. The empty state says which of these applies: nothing in scope, nothing with frontmatter, nothing with a date in the configured field, or everything removed by a filter. Read it rather than guessing.

## Moving around the chart

A long timeline in a narrow pane needs more than a scrollbar, so there are four ways to move:

- **Drag any empty part of the chart** to pan in both directions. Dragging starts only from the background, so panning never competes with rescheduling a bar.
- **Shift + mouse wheel** scrolls horizontally.
- **Arrow keys** once the chart has focus; **Home** and **End** jump to the ends, and **Ctrl + Left/Right** moves a full screen at a time.
- **Today** re-centres on the current date. The chart also opens centred there.

The **− / +** buttons zoom between day, week, month and quarter. The header row and the label column stay frozen while you scroll, on both axes.

## Options

All options are `key: value`, one per line. Unknown keys are reported as errors rather than ignored, so a typo never silently produces an empty chart.

| Option | Values | Default |
|---|---|---|
| `title` | Heading shown above the chart | none |
| `folder` | Restrict to a folder and its children | whole vault |
| `file` | A single note by path or name. `this` means the note containing the block | none |
| `tag` | Comma-separated. `project` also matches `project/design` | none |
| `status` | Comma-separated allow-list | all |
| `exclude-status` | Comma-separated deny-list | none |
| `source` | `notes`, `tasks`, `both` | `notes` |
| `scale` | `day`, `week`, `month`, `quarter` | `week` |
| `from` / `to` | `YYYY-MM-DD` window | auto-fit |
| `group` | A frontmatter field name, or `folder` | none |
| `sort` | `start`, `end`, `title`, `status` | `start` |
| `reverse` | `true` / `false` | `false` |
| `limit` | Maximum rows | unlimited |
| `start-field` | Override the start field for this block | `start_date` |
| `end-field` | Override the end field for this block | `due_date` |
| `done-field` | Override the completion field | `completed_date` |
| `status-field` | Override the status field | `status` |
| `show-today` | `true` / `false` | from settings |
| `readonly` | `true` disables editing for this block | `false` |
| `hide-finished` | `true` hides `completed`, `finished` and `done` items | `false` |

Field names default to whatever is set in the plugin's settings tab, so if your vault uses `starts`/`ends` you set that once rather than per block.

### Examples

Everything active across the vault, month scale, grouped by client:

````markdown
```gantt
title: 2026 Commitments
scale: month
status: active, planned, waiting
group: company
```
````

One project in detail, day by day:

````markdown
```gantt
folder: 03_Projects/Active
scale: day
from: 2026-09-01
to: 2026-10-15
```
````

Dated tasks written in the current note, which needs no frontmatter anywhere:

````markdown
```gantt
file: this
source: tasks
scale: week
```
````

## Inline task format

With `source: tasks` the plugin reads checkbox lines carrying dates, in either the Tasks-plugin emoji format or Dataview inline-field format:

```markdown
- [ ] Confirm laundry exhaust volume 🛫 2026-08-05 📅 2026-08-20
- [x] Survey 3F switches [start:: 2026-07-20] [completion:: 2026-07-28]
```

Checkbox state maps to status: `[ ]` and `[/]` are active, `[x]` is completed, `[-]` is cancelled, `[>]` is waiting.

## Theming

The chart uses Obsidian's own CSS variables throughout — `--background-primary`, `--text-normal`, `--background-modifier-border`, `--color-green`, and so on. There are no hardcoded colours, so it follows light and dark mode and any community theme automatically.

Bar colours come from the note's `status`:

| Status | Colour |
|---|---|
| `active` | green |
| `planned` | blue |
| `proposed` | cyan |
| `waiting` | orange |
| `paused` | yellow |
| `completed`, `finished`, `done`, `archived` | muted grey, dimmed |
| `review` | pink |
| `cancelled` | red |
| `reference`, `evergreen` | purple |
| anything else | theme accent |

To restyle it, override the `.wgantt-*` classes in your own CSS snippet. Sizing is driven by three custom properties on `.wgantt-body`: `--wg-label-width`, `--wg-row-height`, `--wg-bar-height`.

## Editing

The chart is editable. This is the one place the plugin writes to your vault, so it is worth knowing exactly what it touches.

| Control | What it writes |
|---|---|
| Drag a bar sideways | `start_date` and `due_date` shift together |
| Drag a bar's left or right edge | Only that one date changes |
| **✓** on a row (appears on hover) | `status: completed` plus today's date in `completed_date` |
| **↺** on a completed row | `status: active`, and `completed_date` is removed |
| **✎** on a row | Opens a dialog for start, due, and status |
| **+ New project** | Creates a new note with frontmatter and a short skeleton body |

Rules the editing follows:

- Frontmatter changes go through Obsidian's own `processFrontMatter`, so only the YAML block is rewritten. **Note bodies are never touched, and nothing is ever deleted.**
- Dragging never invents a date. A milestone with only a `due_date` keeps only a `due_date`.
- An edge cannot be dragged past the opposite edge, so a negative span is not reachable.
- `updated` is refreshed on every write.
- Clicking a bar still opens the note. A movement under four pixels counts as a click, not a drag.
- Inline tasks (`source: tasks`) are **not** editable — that would mean rewriting inline markup rather than YAML. Their rows have no edit controls.

To turn all of this off, either set **Allow editing** to off in the plugin settings, or put `readonly: true` in an individual block.

## What it does not do

Deliberately:

- **No network access.** There is no `fetch`, `requestUrl`, `XMLHttpRequest`, or `WebSocket` anywhere in the source.
- **No dependencies.** Nothing from npm, so there is no supply chain to audit and no `postinstall` script.
- **No editing of inline tasks.** Only frontmatter-backed notes are editable.
- **No dependency arrows between tasks.** Possible later; it needs a link convention first.
- **No undo of its own.** A drag writes immediately. Obsidian's file recovery is the safety net; the done toggle is reversible by design.

## Verifying it yourself

```bash
grep -nE "fetch|requestUrl|XMLHttpRequest|WebSocket|eval|new Function|child_process|require\(" main.js
```

The only `require` is Obsidian's own API. Everything else should return nothing but the comment at the top of the file that names these terms.

## Licence

MIT.
