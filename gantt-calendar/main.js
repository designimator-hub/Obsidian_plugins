'use strict';

/*
 * Wright Gantt Calendar - an Obsidian plugin.
 *
 * Design constraints, deliberately:
 *   - Zero dependencies.
 *   - No build step. This file is the plugin.
 *   - No network access of any kind. There is no fetch, requestUrl,
 *     XMLHttpRequest, WebSocket, or dynamic code execution anywhere below.
 *     Search this file for those words; you will not find them outside
 *     this comment.
 *   - No writes to your vault. The plugin reads notes and renders. The only
 *     thing it ever writes is its own settings file.
 *
 * Everything is rendered from note frontmatter and, optionally, inline tasks.
 */

const { Plugin, PluginSettingTab, Setting, MarkdownRenderChild } = require('obsidian');

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
	startField: 'start_date',
	endField: 'due_date',
	doneField: 'completed_date',
	statusField: 'status',
	groupFieldDefault: '',
	defaultScale: 'week',
	weekStart: 1, // 0 = Sunday, 1 = Monday
	labelWidth: 240,
	rowHeight: 30,
	barHeight: 18,
	showToday: true,
	openInNewPane: false,
};

/* Scale definitions. pxPerDay drives every horizontal measurement. */
const SCALES = {
	day: { pxPerDay: 34, minor: 'day', major: 'month' },
	week: { pxPerDay: 13, minor: 'week', major: 'month' },
	month: { pxPerDay: 3.6, minor: 'month', major: 'year' },
	quarter: { pxPerDay: 1.5, minor: 'quarter', major: 'year' },
};

/*
 * Status -> theme colour variable. These are Obsidian's own colour tokens,
 * so the chart follows whatever theme is active rather than hardcoding hex.
 */
const STATUS_COLORS = {
	active: 'var(--color-green)',
	planned: 'var(--color-blue)',
	proposed: 'var(--color-cyan)',
	waiting: 'var(--color-orange)',
	paused: 'var(--color-yellow)',
	completed: 'var(--text-faint)',
	done: 'var(--text-faint)',
	cancelled: 'var(--color-red)',
	archived: 'var(--text-faint)',
	reference: 'var(--color-purple)',
	evergreen: 'var(--color-purple)',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

/* ------------------------------------------------------------------ *
 * Small DOM helper
 *
 * Deliberately not using innerHTML anywhere. All text goes through
 * textContent, so note titles cannot inject markup into the chart.
 * ------------------------------------------------------------------ */

function el(tag, cls, parent, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text != null) node.textContent = String(text);
	if (parent) parent.appendChild(node);
	return node;
}

/* ------------------------------------------------------------------ *
 * Dates
 *
 * Everything is normalised to local midnight so that arithmetic is in
 * whole days and never drifts across a timezone boundary.
 * ------------------------------------------------------------------ */

function parseDate(value) {
	if (value == null) return null;

	// Obsidian parses bare YAML dates into Date objects at UTC midnight.
	// Read them back with UTC getters, otherwise a negative offset shifts
	// the date back by one day.
	if (value instanceof Date) {
		if (isNaN(value.getTime())) return null;
		return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
	}

	const s = String(value).trim();
	if (!s) return null;
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!m) return null;

	const y = Number(m[1]);
	const mo = Number(m[2]);
	const d = Number(m[3]);
	const dt = new Date(y, mo - 1, d);

	// Rejects impossible dates such as 2026-02-31, which Date would roll over.
	if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
	return dt;
}

function today() {
	const n = new Date();
	return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function addDays(date, n) {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function daysBetween(a, b) {
	return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function isoDate(date) {
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${m}-${d}`;
}

function startOfWeek(date, weekStart) {
	const shift = (date.getDay() - weekStart + 7) % 7;
	return addDays(date, -shift);
}

function startOfMonth(date) {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfQuarter(date) {
	return new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1);
}

function startOfYear(date) {
	return new Date(date.getFullYear(), 0, 1);
}

/* ------------------------------------------------------------------ *
 * Code block configuration
 *
 * Syntax is one `key: value` per line. Unknown keys are reported rather
 * than ignored, so a typo does not silently produce an empty chart.
 * ------------------------------------------------------------------ */

const KNOWN_KEYS = new Set([
	'title', 'folder', 'tag', 'status', 'exclude-status', 'source',
	'scale', 'from', 'to', 'group', 'sort', 'reverse', 'limit',
	'start-field', 'end-field', 'done-field', 'status-field',
	'show-today', 'hide-empty',
]);

function parseConfig(source) {
	const cfg = {
		title: '',
		folder: '',
		tags: [],
		status: [],
		excludeStatus: [],
		source: 'notes',
		scale: null,
		from: null,
		to: null,
		group: '',
		sort: 'start',
		reverse: false,
		limit: 0,
		startField: null,
		endField: null,
		doneField: null,
		statusField: null,
		showToday: null,
		hideEmpty: true,
	};
	const errors = [];

	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith('//')) continue;

		const idx = line.indexOf(':');
		if (idx === -1) {
			errors.push(`Line ${i + 1}: expected "key: value", got "${line}"`);
			continue;
		}

		const key = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();

		if (!KNOWN_KEYS.has(key)) {
			errors.push(`Line ${i + 1}: unknown option "${key}"`);
			continue;
		}

		const list = () => value.split(',').map((s) => s.trim()).filter(Boolean);

		switch (key) {
			case 'title': cfg.title = value; break;
			case 'folder': cfg.folder = value.replace(/^\/+|\/+$/g, ''); break;
			case 'tag': cfg.tags = list().map((t) => t.replace(/^#/, '').toLowerCase()); break;
			case 'status': cfg.status = list().map((s) => s.toLowerCase()); break;
			case 'exclude-status': cfg.excludeStatus = list().map((s) => s.toLowerCase()); break;
			case 'group': cfg.group = value; break;
			case 'sort': cfg.sort = value.toLowerCase(); break;
			case 'reverse': cfg.reverse = /^(true|yes|1)$/i.test(value); break;
			case 'hide-empty': cfg.hideEmpty = !/^(false|no|0)$/i.test(value); break;
			case 'show-today': cfg.showToday = !/^(false|no|0)$/i.test(value); break;
			case 'start-field': cfg.startField = value; break;
			case 'end-field': cfg.endField = value; break;
			case 'done-field': cfg.doneField = value; break;
			case 'status-field': cfg.statusField = value; break;

			case 'source': {
				const v = value.toLowerCase();
				if (v !== 'notes' && v !== 'tasks' && v !== 'both') {
					errors.push(`Line ${i + 1}: source must be notes, tasks, or both`);
				} else cfg.source = v;
				break;
			}
			case 'scale': {
				const v = value.toLowerCase();
				if (!SCALES[v]) {
					errors.push(`Line ${i + 1}: scale must be one of ${Object.keys(SCALES).join(', ')}`);
				} else cfg.scale = v;
				break;
			}
			case 'from':
			case 'to': {
				const d = parseDate(value);
				if (!d) errors.push(`Line ${i + 1}: "${value}" is not a YYYY-MM-DD date`);
				else if (key === 'from') cfg.from = d;
				else cfg.to = d;
				break;
			}
			case 'limit': {
				const n = parseInt(value, 10);
				if (isNaN(n) || n < 0) errors.push(`Line ${i + 1}: limit must be a positive number`);
				else cfg.limit = n;
				break;
			}
		}
	}

	if (cfg.from && cfg.to && cfg.from > cfg.to) {
		errors.push('"from" is later than "to"');
	}

	return { cfg, errors };
}

/* ------------------------------------------------------------------ *
 * Collecting items
 * ------------------------------------------------------------------ */

function fileTags(cache) {
	const out = [];
	if (!cache) return out;
	if (Array.isArray(cache.tags)) {
		for (const t of cache.tags) {
			if (t && t.tag) out.push(String(t.tag).replace(/^#/, '').toLowerCase());
		}
	}
	const fm = cache.frontmatter;
	if (fm && fm.tags != null) {
		const raw = Array.isArray(fm.tags) ? fm.tags : String(fm.tags).split(',');
		for (const t of raw) {
			const s = String(t).trim().replace(/^#/, '').toLowerCase();
			if (s) out.push(s);
		}
	}
	return out;
}

function matchesTag(itemTags, wanted) {
	// A wanted tag matches itself or any nested child: "project" matches
	// "project/design".
	return wanted.every((w) => itemTags.some((t) => t === w || t.startsWith(w + '/')));
}

function collectFromNotes(app, cfg, s) {
	const startField = cfg.startField || s.startField;
	const endField = cfg.endField || s.endField;
	const doneField = cfg.doneField || s.doneField;
	const statusField = cfg.statusField || s.statusField;

	const items = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (cfg.folder && !(file.path === cfg.folder || file.path.startsWith(cfg.folder + '/'))) continue;

		const cache = app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (!fm) continue;

		const start = parseDate(fm[startField]);
		const end = parseDate(fm[endField]);
		const done = parseDate(fm[doneField]);
		if (!start && !end && !done) continue;

		const status = fm[statusField] != null ? String(fm[statusField]).toLowerCase() : '';
		if (cfg.status.length && !cfg.status.includes(status)) continue;
		if (cfg.excludeStatus.length && cfg.excludeStatus.includes(status)) continue;

		const tags = fileTags(cache);
		if (cfg.tags.length && !matchesTag(tags, cfg.tags)) continue;

		let group = '';
		if (cfg.group === 'folder') {
			group = file.parent ? file.parent.path : '/';
		} else if (cfg.group && fm[cfg.group] != null) {
			group = String(fm[cfg.group]);
		}

		items.push({
			title: fm.title != null ? String(fm.title) : file.basename,
			start, end, done, status, group,
			path: file.path,
			line: null,
		});
	}
	return items;
}

/* Inline task dates, in both Tasks-plugin emoji form and Dataview form. */
const TASK_LINE = /^\s*[-*+]\s+\[(.)\]\s+(.+)$/;
const EMOJI_START = /[\u{1F6EB}\u{1F195}]\s*(\d{4}-\d{2}-\d{2})/u; // 🛫 start
const EMOJI_DUE = /[\u{1F4C5}\u{23F3}]\s*(\d{4}-\d{2}-\d{2})/u;     // 📅 due, ⏳ scheduled
const EMOJI_DONE = /\u{2705}\s*(\d{4}-\d{2}-\d{2})/u;               // ✅ done
const DV_FIELD = /\[(start|due|scheduled|completion)::\s*(\d{4}-\d{2}-\d{2})\s*\]/gi;

const CHECKBOX_STATUS = { ' ': 'active', 'x': 'completed', 'X': 'completed', '/': 'active', '-': 'cancelled', '>': 'waiting' };

async function collectFromTasks(app, cfg) {
	const items = [];

	for (const file of app.vault.getMarkdownFiles()) {
		if (cfg.folder && !(file.path === cfg.folder || file.path.startsWith(cfg.folder + '/'))) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache || !Array.isArray(cache.listItems)) continue;
		if (!cache.listItems.some((li) => li.task != null)) continue;

		if (cfg.tags.length && !matchesTag(fileTags(cache), cfg.tags)) continue;

		let text;
		try {
			text = await app.vault.cachedRead(file);
		} catch (e) {
			continue;
		}
		const lines = text.split('\n');

		for (const li of cache.listItems) {
			if (li.task == null) continue;
			const lineNo = li.position.start.line;
			const raw = lines[lineNo];
			if (!raw) continue;

			const m = raw.match(TASK_LINE);
			if (!m) continue;

			const mark = m[1];
			let body = m[2];

			let start = null, end = null, done = null;

			const ms = body.match(EMOJI_START);
			if (ms) start = parseDate(ms[1]);
			const md = body.match(EMOJI_DUE);
			if (md) end = parseDate(md[1]);
			const mdone = body.match(EMOJI_DONE);
			if (mdone) done = parseDate(mdone[1]);

			DV_FIELD.lastIndex = 0;
			let dv;
			while ((dv = DV_FIELD.exec(body)) !== null) {
				const d = parseDate(dv[2]);
				const kind = dv[1].toLowerCase();
				if (kind === 'start') start = start || d;
				else if (kind === 'completion') done = done || d;
				else end = end || d;
			}

			if (!start && !end && !done) continue;

			// Strip the date markup and any trailing tags from the label.
			body = body
				.replace(EMOJI_START, '').replace(EMOJI_DUE, '').replace(EMOJI_DONE, '')
				.replace(DV_FIELD, '')
				.replace(/\s+/g, ' ')
				.trim();

			const status = CHECKBOX_STATUS[mark] || 'active';
			if (cfg.status.length && !cfg.status.includes(status)) continue;
			if (cfg.excludeStatus.length && cfg.excludeStatus.includes(status)) continue;

			items.push({
				title: body || '(untitled task)',
				start, end, done, status,
				group: cfg.group === 'folder' ? (file.parent ? file.parent.path : '/') : (cfg.group ? file.basename : ''),
				path: file.path,
				line: lineNo,
			});
		}
	}
	return items;
}

/*
 * Give every item a concrete span.
 * An item with only one date becomes a milestone rather than a zero-width bar.
 */
function normaliseSpans(items) {
	for (const it of items) {
		const end = it.end || it.done;
		if (it.start && end) {
			// Tolerate reversed dates rather than rendering a negative bar.
			if (end < it.start) {
				it.spanStart = end;
				it.spanEnd = it.start;
				it.reversed = true;
			} else {
				it.spanStart = it.start;
				it.spanEnd = end;
			}
			it.milestone = daysBetween(it.spanStart, it.spanEnd) === 0;
		} else {
			const only = it.start || end;
			it.spanStart = only;
			it.spanEnd = only;
			it.milestone = true;
		}
	}
	return items;
}

function sortItems(items, cfg) {
	const dir = cfg.reverse ? -1 : 1;
	const by = cfg.sort;
	items.sort((a, b) => {
		let r = 0;
		if (by === 'title') r = a.title.localeCompare(b.title);
		else if (by === 'status') r = String(a.status).localeCompare(String(b.status));
		else if (by === 'end') r = a.spanEnd - b.spanEnd;
		else r = a.spanStart - b.spanStart;
		if (r === 0) r = a.title.localeCompare(b.title);
		return r * dir;
	});
	return items;
}

/* ------------------------------------------------------------------ *
 * Axis ticks
 * ------------------------------------------------------------------ */

function stepStarts(kind, from, to, weekStart) {
	const out = [];
	let cur;
	if (kind === 'day') cur = new Date(from);
	else if (kind === 'week') cur = startOfWeek(from, weekStart);
	else if (kind === 'month') cur = startOfMonth(from);
	else if (kind === 'quarter') cur = startOfQuarter(from);
	else cur = startOfYear(from);

	let guard = 0;
	while (cur <= to && guard++ < 5000) {
		out.push(cur);
		if (kind === 'day') cur = addDays(cur, 1);
		else if (kind === 'week') cur = addDays(cur, 7);
		else if (kind === 'month') cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
		else if (kind === 'quarter') cur = new Date(cur.getFullYear(), cur.getMonth() + 3, 1);
		else cur = new Date(cur.getFullYear() + 1, 0, 1);
	}
	return out;
}

function tickLabel(kind, date, weekStart) {
	if (kind === 'day') return String(date.getDate());
	if (kind === 'week') return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
	if (kind === 'month') return MONTHS[date.getMonth()];
	if (kind === 'quarter') return `Q${Math.floor(date.getMonth() / 3) + 1}`;
	return String(date.getFullYear());
}

function majorLabel(kind, date) {
	if (kind === 'month') return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
	return String(date.getFullYear());
}

/* ------------------------------------------------------------------ *
 * The render child
 * ------------------------------------------------------------------ */

class GanttBlock extends MarkdownRenderChild {
	constructor(containerEl, plugin, source) {
		super(containerEl);
		this.plugin = plugin;
		this.source = source;
		this.refreshTimer = null;
	}

	onload() {
		this.render();

		// Re-render when vault metadata changes, debounced so that a bulk
		// edit does not trigger a redraw per file.
		const schedule = () => {
			if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(() => {
				this.refreshTimer = null;
				this.render();
			}, 600);
		};
		this.registerEvent(this.plugin.app.metadataCache.on('changed', schedule));
		this.registerEvent(this.plugin.app.vault.on('delete', schedule));
		this.registerEvent(this.plugin.app.vault.on('rename', schedule));
	}

	onunload() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
	}

	async render() {
		const root = this.containerEl;
		root.textContent = '';
		root.className = 'wgantt';

		const { cfg, errors } = parseConfig(this.source);

		if (errors.length) {
			const box = el('div', 'wgantt-error', root);
			el('div', 'wgantt-error-title', box, 'Gantt block has errors');
			const ul = el('ul', null, box);
			for (const e of errors) el('li', null, ul, e);
			return;
		}

		const s = this.plugin.settings;
		const scaleName = cfg.scale || s.defaultScale;
		const scale = SCALES[scaleName] || SCALES.week;

		let items = [];
		try {
			if (cfg.source === 'notes' || cfg.source === 'both') {
				items = items.concat(collectFromNotes(this.plugin.app, cfg, s));
			}
			if (cfg.source === 'tasks' || cfg.source === 'both') {
				items = items.concat(await collectFromTasks(this.plugin.app, cfg));
			}
		} catch (e) {
			const box = el('div', 'wgantt-error', root);
			el('div', 'wgantt-error-title', box, 'Gantt failed to read notes');
			el('div', null, box, String(e && e.message ? e.message : e));
			return;
		}

		normaliseSpans(items);

		// Clip to an explicit window if one was given.
		if (cfg.from) items = items.filter((i) => i.spanEnd >= cfg.from);
		if (cfg.to) items = items.filter((i) => i.spanStart <= cfg.to);

		sortItems(items, cfg);
		if (cfg.limit) items = items.slice(0, cfg.limit);

		if (cfg.title) el('div', 'wgantt-title', root, cfg.title);

		if (!items.length) {
			el('div', 'wgantt-empty', root,
				'Nothing to chart. Check that notes in scope have a ' +
				`"${cfg.startField || s.startField}" or "${cfg.endField || s.endField}" value.`);
			return;
		}

		// Work out the visible range.
		let rangeStart = cfg.from || items.reduce((a, i) => (i.spanStart < a ? i.spanStart : a), items[0].spanStart);
		let rangeEnd = cfg.to || items.reduce((a, i) => (i.spanEnd > a ? i.spanEnd : a), items[0].spanEnd);

		// Pad so bars do not touch the edges.
		const pad = scaleName === 'day' ? 1 : scaleName === 'week' ? 3 : 14;
		rangeStart = addDays(rangeStart, -pad);
		rangeEnd = addDays(rangeEnd, pad);

		const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
		const pxPerDay = scale.pxPerDay;
		const canvasWidth = Math.max(totalDays * pxPerDay, 200);
		const x = (d) => daysBetween(rangeStart, d) * pxPerDay;

		this.buildToolbar(root, items, scaleName);

		const body = el('div', 'wgantt-body', root);
		body.style.setProperty('--wg-label-width', s.labelWidth + 'px');
		body.style.setProperty('--wg-row-height', s.rowHeight + 'px');
		body.style.setProperty('--wg-bar-height', s.barHeight + 'px');

		const labels = el('div', 'wgantt-labels', body);
		const scroll = el('div', 'wgantt-scroll', body);
		const canvas = el('div', 'wgantt-canvas', scroll);
		canvas.style.width = canvasWidth + 'px';

		el('div', 'wgantt-labels-head', labels);
		this.buildAxis(canvas, scale, rangeStart, rangeEnd, x, canvasWidth, s.weekStart);

		const grid = el('div', 'wgantt-grid', canvas);
		const rows = el('div', 'wgantt-rows', canvas);

		// Vertical gridlines on the minor ticks.
		for (const t of stepStarts(scale.minor, rangeStart, rangeEnd, s.weekStart)) {
			if (t < rangeStart) continue;
			const line = el('div', 'wgantt-gridline', grid);
			line.style.left = x(t) + 'px';
		}

		this.buildRows(labels, rows, items, cfg, x, pxPerDay);

		// Today marker.
		const showToday = cfg.showToday == null ? s.showToday : cfg.showToday;
		const t = today();
		if (showToday && t >= rangeStart && t <= rangeEnd) {
			const line = el('div', 'wgantt-today', canvas);
			line.style.left = x(t) + 'px';
			line.title = 'Today - ' + isoDate(t);
		}

		// Open on today where that is meaningful.
		if (t >= rangeStart && t <= rangeEnd) {
			window.setTimeout(() => {
				scroll.scrollLeft = Math.max(0, x(t) - scroll.clientWidth / 2);
			}, 0);
		}
	}

	buildToolbar(root, items, scaleName) {
		const bar = el('div', 'wgantt-toolbar', root);
		el('span', 'wgantt-count', bar, `${items.length} item${items.length === 1 ? '' : 's'}`);
		el('span', 'wgantt-scalename', bar, scaleName);
	}

	buildAxis(canvas, scale, rangeStart, rangeEnd, x, canvasWidth, weekStart) {
		const head = el('div', 'wgantt-head', canvas);

		const majorRow = el('div', 'wgantt-major', head);
		const majors = stepStarts(scale.major, rangeStart, rangeEnd, weekStart);
		for (let i = 0; i < majors.length; i++) {
			const from = majors[i] < rangeStart ? rangeStart : majors[i];
			const next = majors[i + 1] || addDays(rangeEnd, 1);
			const left = x(from);
			const width = Math.max(x(next) - left, 0);
			if (width < 1) continue;
			const cell = el('div', 'wgantt-major-cell', majorRow, majorLabel(scale.major, majors[i]));
			cell.style.left = left + 'px';
			cell.style.width = width + 'px';
		}

		const minorRow = el('div', 'wgantt-minor', head);
		const minors = stepStarts(scale.minor, rangeStart, rangeEnd, weekStart);
		for (let i = 0; i < minors.length; i++) {
			const d = minors[i];
			if (d < rangeStart) continue;
			const cell = el('div', 'wgantt-minor-cell', minorRow, tickLabel(scale.minor, d, weekStart));
			cell.style.left = x(d) + 'px';
			const next = minors[i + 1];
			if (next) cell.style.width = Math.max(x(next) - x(d), 0) + 'px';
			if (scale.minor === 'day') {
				const dow = d.getDay();
				if (dow === 0 || dow === 6) cell.classList.add('is-weekend');
			}
		}
	}

	buildRows(labels, rows, items, cfg, x, pxPerDay) {
		let lastGroup = null;

		for (const item of items) {
			if (cfg.group) {
				const g = item.group || '(ungrouped)';
				if (g !== lastGroup) {
					lastGroup = g;
					el('div', 'wgantt-group-label', labels, g);
					el('div', 'wgantt-group-row', rows);
				}
			}

			// Left-hand label.
			const label = el('div', 'wgantt-label', labels);
			const link = el('span', 'wgantt-label-text', label, item.title);
			link.title = item.path + (item.line != null ? `:${item.line + 1}` : '');
			label.addEventListener('click', () => this.openItem(item));

			if (item.status) {
				const dot = el('span', 'wgantt-dot', label);
				dot.style.background = STATUS_COLORS[item.status] || 'var(--interactive-accent)';
				dot.title = item.status;
			}

			// Right-hand row.
			const row = el('div', 'wgantt-row', rows);
			const colour = STATUS_COLORS[item.status] || 'var(--interactive-accent)';
			const left = x(item.spanStart);

			let bar;
			if (item.milestone) {
				bar = el('div', 'wgantt-milestone', row);
				bar.style.left = left + 'px';
				bar.style.background = colour;
			} else {
				bar = el('div', 'wgantt-bar', row);
				bar.style.left = left + 'px';
				// End date is inclusive, so add one day of width.
				bar.style.width = Math.max((daysBetween(item.spanStart, item.spanEnd) + 1) * pxPerDay, 3) + 'px';
				bar.style.background = colour;
				if (item.status === 'completed' || item.status === 'done') bar.classList.add('is-done');
				if (item.reversed) bar.classList.add('is-reversed');

				// Only label inside the bar when there is room for it.
				const w = parseFloat(bar.style.width);
				if (w > 60) el('span', 'wgantt-bar-text', bar, item.title);
			}

			const span = item.milestone
				? isoDate(item.spanStart)
				: `${isoDate(item.spanStart)} to ${isoDate(item.spanEnd)}`;
			bar.title = `${item.title}\n${span}${item.status ? '\n' + item.status : ''}` +
				(item.reversed ? '\n(dates were reversed in the note)' : '');
			bar.addEventListener('click', () => this.openItem(item));
		}
	}

	openItem(item) {
		const newPane = this.plugin.settings.openInNewPane;
		this.plugin.app.workspace.openLinkText(item.path, '', newPane).then(() => {
			if (item.line == null) return;
			const view = this.plugin.app.workspace.getActiveViewOfType(
				require('obsidian').MarkdownView
			);
			if (view && view.editor) {
				view.editor.setCursor({ line: item.line, ch: 0 });
				view.editor.scrollIntoView(
					{ from: { line: item.line, ch: 0 }, to: { line: item.line, ch: 0 } }, true
				);
			}
		}).catch(() => { /* file may have been removed since render */ });
	}
}

/* ------------------------------------------------------------------ *
 * Settings tab
 * ------------------------------------------------------------------ */

class GanttSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		const save = async () => { await this.plugin.saveSettings(); };

		const text = (name, desc, key, placeholder) => {
			new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
				t.setPlaceholder(placeholder || '')
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (v) => { this.plugin.settings[key] = v.trim(); await save(); }));
		};

		const number = (name, desc, key, min, max) => {
			new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
				t.setValue(String(this.plugin.settings[key]))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n >= min && n <= max) {
							this.plugin.settings[key] = n;
							await save();
						}
					}));
		};

		new Setting(containerEl).setName('Frontmatter fields').setHeading();
		text('Start field', 'Frontmatter key holding the start date.', 'startField', 'start_date');
		text('End field', 'Frontmatter key holding the end or due date.', 'endField', 'due_date');
		text('Completed field', 'Used as the end date when no end date is set.', 'doneField', 'completed_date');
		text('Status field', 'Drives bar colour.', 'statusField', 'status');

		new Setting(containerEl).setName('Appearance').setHeading();

		new Setting(containerEl)
			.setName('Default scale')
			.setDesc('Used when a block does not set one.')
			.addDropdown((d) => {
				for (const k of Object.keys(SCALES)) d.addOption(k, k);
				d.setValue(this.plugin.settings.defaultScale)
					.onChange(async (v) => { this.plugin.settings.defaultScale = v; await save(); });
			});

		new Setting(containerEl)
			.setName('Week starts on')
			.addDropdown((d) => {
				d.addOption('0', 'Sunday');
				d.addOption('1', 'Monday');
				d.setValue(String(this.plugin.settings.weekStart))
					.onChange(async (v) => { this.plugin.settings.weekStart = parseInt(v, 10); await save(); });
			});

		number('Label column width', 'Pixels.', 'labelWidth', 100, 600);
		number('Row height', 'Pixels.', 'rowHeight', 18, 80);
		number('Bar height', 'Pixels. Should be less than row height.', 'barHeight', 6, 60);

		new Setting(containerEl)
			.setName('Show today marker')
			.addToggle((t) => t.setValue(this.plugin.settings.showToday)
				.onChange(async (v) => { this.plugin.settings.showToday = v; await save(); }));

		new Setting(containerEl)
			.setName('Open notes in a new pane')
			.addToggle((t) => t.setValue(this.plugin.settings.openInNewPane)
				.onChange(async (v) => { this.plugin.settings.openInNewPane = v; await save(); }));

		new Setting(containerEl).setName('About').setHeading();
		const about = containerEl.createDiv({ cls: 'wgantt-about' });
		about.createEl('p', {
			text: 'This plugin makes no network requests, and writes nothing to your vault ' +
				'except this settings file. It reads note frontmatter and renders a chart.',
		});
	}
}

/* ------------------------------------------------------------------ *
 * Plugin entry point
 * ------------------------------------------------------------------ */

module.exports = class GanttCalendarPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor('gantt', (source, elParent, ctx) => {
			const child = new GanttBlock(elParent, this, source);
			ctx.addChild(child);
		});

		this.addSettingTab(new GanttSettingTab(this.app, this));

		this.addCommand({
			id: 'insert-gantt-block',
			name: 'Insert Gantt block',
			editorCallback: (editor) => {
				editor.replaceSelection(
					'```gantt\n' +
					'title: Project Timeline\n' +
					'folder: 03_Projects\n' +
					'scale: week\n' +
					'sort: start\n' +
					'```\n'
				);
			},
		});
	}

	async loadSettings() {
		const stored = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
};

/*
 * Pure helpers, exposed as a static property so that test/run-tests.js can
 * exercise the date and config logic without Obsidian running. Attaching this
 * to the exported class is inert at runtime - Obsidian only ever constructs
 * the plugin - and it keeps the project testable without a build step.
 */
module.exports.__test = {
	parseDate, addDays, daysBetween, isoDate,
	startOfWeek, startOfMonth, startOfQuarter, startOfYear,
	parseConfig, normaliseSpans, sortItems, stepStarts,
	matchesTag, tickLabel, majorLabel,
	SCALES, STATUS_COLORS, DEFAULT_SETTINGS,
};
