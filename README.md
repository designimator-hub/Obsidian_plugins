# Obsidian Plugins

Self-written Obsidian plugins, kept deliberately small and auditable.

## Design rules

Everything in this repository follows the same rules:

- **No dependencies.** Nothing from npm, so there is no supply chain and no `postinstall` script.
- **No build step.** The `main.js` in the repository is the `main.js` that runs. Nothing is bundled or minified, so what you read is what executes.
- **No network access.** No `fetch`, `requestUrl`, `XMLHttpRequest`, or `WebSocket`.
- **No dynamic execution.** No `eval`, no `new Function`, no `child_process`.
- **Readable in one sitting.** If it grows past that, it needs justifying.

## Plugins

| Plugin | What it does |
|---|---|
| [gantt-calendar](gantt-calendar/) | Renders Gantt charts from note frontmatter dates. Code-block driven, theme-aware. |

## Installing any of these

There is no build step, so installation is a copy:

```
<your vault>/.obsidian/plugins/<plugin-id>/
├── main.js
├── manifest.json
└── styles.css
```

Then enable it in **Settings → Community plugins**. Read `main.js` first — that is the entire point of keeping them this small.

## Licence

MIT.
