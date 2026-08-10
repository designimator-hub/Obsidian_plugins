# Wright Gantt Calendar

A Gantt chart for Obsidian that reads dates out of your note frontmatter.

Built to be auditable rather than featureful. Three files, no dependencies, no build step, and no network code — you can read the whole thing in one sitting and know what it does.

## Install

There is no build step. Copy the plugin folder into your vault:

```
<your vault>/.obsidian/plugins/wright-gantt-calendar/
├── main.js
├── manifest.json
└── styles.css
```

Then enable it in **Settings → Community plugins**.

To verify what you installed before enabling it, read `main.js` top to bottom. It is around 1,000 lines, commented, and written in plain JavaScript rather than bundled output.

## Usage

Two ways in.

**The ribbon icon.** A calendar icon appears in the left ribbon once the plugin is enabled. It opens a vault-wide Gantt as a full tab, with dropdowns for folder, scale, sort, and grouping. Your selections are remembered. The same thing is on the command palette as **Open Gantt calendar**.

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
| `completed`, `archived` | muted grey, dimmed |
| `cancelled` | red |
| `reference`, `evergreen` | purple |
| anything else | theme accent |

To restyle it, override the `.wgantt-*` classes in your own CSS snippet. Sizing is driven by three custom properties on `.wgantt-body`: `--wg-label-width`, `--wg-row-height`, `--wg-bar-height`.

## What it does not do

Deliberately:

- **No network access.** There is no `fetch`, `requestUrl`, `XMLHttpRequest`, or `WebSocket` anywhere in the source.
- **No writes to your notes.** It reads and renders. The only file it writes is its own `data.json` settings.
- **No dependencies.** Nothing from npm, so there is no supply chain to audit and no `postinstall` script.
- **No dragging bars to edit dates.** Editing happens in the note, which stays the source of truth.
- **No dependency arrows between tasks.** Possible later; it needs a link convention first.

## Verifying it yourself

```bash
grep -nE "fetch|requestUrl|XMLHttpRequest|WebSocket|eval|new Function|child_process|require\(" main.js
```

The only `require` is Obsidian's own API. Everything else should return nothing but the comment at the top of the file that names these terms.

## Licence

MIT.
