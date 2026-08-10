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
 * Two ways in:
 *   - a ```gantt code block in any note
 *   - the ribbon icon / "Open Gantt calendar" command, which opens a
 *     vault-wide chart with its own controls
 */

const {
	Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView, Notice,
} = require('obsidian');

const VIEW_TYPE_GANTT = 'wright-gantt-view';
const RIBBON_ICON = 'calendar-range';

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
	startField: 'start_date',
	endField: 'due_date',
	doneField: 'completed_date',
	statusField: 'status',
	defaultScale: 'week',
	weekStart: 1, // 0 = Sunday, 1 = Monday
	labelWidth: 240,
	rowHeight: 30,
	barHeight: 18,
	showToday: true,
	openInNewPane: false,
	// Remembered state for the sidebar view.
	viewFolder: '',
	viewScale: 'month',
	viewGroup: '',
	viewSort: 'start',
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
 * ------------------------------------------------------------------ */

const KNOWN_KEYS = new Set([
	'title', 'folder', 'file', 'tag', 'status', 'exclude-status', 'source',
	'scale', 'from', 'to', 'group', 'sort', 'reverse', 'limit',
	'start-field', 'end-field', 'done-field', 'status-field',
	'show-today',
]);

function defaultConfig() {
	return {
		title: '',
		folder: '',
		file: '',
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
	};
}

function parseConfig(source) {
	const cfg = defaultConfig();
	const errors = [];

	const lines = source.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
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
			case 'file': cfg.file = value; break;
			case 'tag': cfg.tags = list().map((t) => t.replace(/^#/, '').toLowerCase()); break;
			case 'status': cfg.status = list().map((s) => s.toLowerCase()); break;
			case 'exclude-status': cfg.excludeStatus = list().map((s) => s.toLowerCase()); break;
			case 'group': cfg.group = value; break;
			case 'sort': cfg.sort = value.toLowerCase(); break;
			case 'reverse': cfg.reverse = /^(true|yes|1)$/i.test(value); break;
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

function inScope(file, cfg, sourcePath) {
	if (cfg.file) {
		const target = cfg.file === 'this' ? sourcePath : cfg.file;
		if (!target) return false;
		const want = String(target).replace(/\.md$/i, '');
		const have = file.path.replace(/\.md$/i, '');
		return have === want || file.basename === target.replace(/\.md$/i, '');
	}
	if (cfg.folder) {
		return file.path === cfg.folder || file.path.startsWith(cfg.folder + '/');
	}
	return true;
}

/*
 * Returns { items, stats }. The stats exist so that an empty chart can say
 * why it is empty rather than leaving you guessing.
 */
function collectFromNotes(app, cfg, s, sourcePath) {
	const startField = cfg.startField || s.startField;
	const endField = cfg.endField || s.endField;
	const doneField = cfg.doneField || s.doneField;
	const statusField = cfg.statusField || s.statusField;

	const items = [];
	const stats = {
		scanned: 0, inScope: 0, withFrontmatter: 0,
		withDates: 0, filteredOut: 0,
		startField, endField,
	};

	for (const file of app.vault.getMarkdownFiles()) {
		stats.scanned++;
		if (!inScope(file, cfg, sourcePath)) continue;
		stats.inScope++;

		const cache = app.metadataCache.getFileCache(file);
		const fm = cache && cache.frontmatter;
		if (!fm) continue;
		stats.withFrontmatter++;

		const start = parseDate(fm[startField]);
		const end = parseDate(fm[endField]);
		const done = parseDate(fm[doneField]);
		if (!start && !end && !done) continue;
		stats.withDates++;

		const status = fm[statusField] != null ? String(fm[statusField]).toLowerCase() : '';
		if (cfg.status.length && !cfg.status.includes(status)) { stats.filteredOut++; continue; }
		if (cfg.excludeStatus.length && cfg.excludeStatus.includes(status)) { stats.filteredOut++; continue; }

		const tags = fileTags(cache);
		if (cfg.tags.length && !matchesTag(tags, cfg.tags)) { stats.filteredOut++; continue; }

		let group = '';
		if (cfg.group === 'folder') group = file.parent ? file.parent.path : '/';
		else if (cfg.group && fm[cfg.group] != null) group = String(fm[cfg.group]);

		items.push({
			title: fm.title != null ? String(fm.title) : file.basename,
			start, end, done, status, group,
			path: file.path,
			line: null,
		});
	}
	return { items, stats };
}

/* Inline task dates, in both Tasks-plugin emoji form and Dataview form. */
const TASK_LINE = /^\s*[-*+]\s+\[(.)\]\s+(.+)$/;
const EMOJI_START = /[\u{1F6EB}\u{1F195}]\s*(\d{4}-\d{2}-\d{2})/u; // start
const EMOJI_DUE = /[\u{1F4C5}\u{23F3}]\s*(\d{4}-\d{2}-\d{2})/u;     // due, scheduled
const EMOJI_DONE = /\u{2705}\s*(\d{4}-\d{2}-\d{2})/u;               // done
const DV_FIELD = /\[(start|due|scheduled|completion)::\s*(\d{4}-\d{2}-\d{2})\s*\]/gi;

const CHECKBOX_STATUS = { ' ': 'active', 'x': 'completed', 'X': 'completed', '/': 'active', '-': 'cancelled', '>': 'waiting' };

async function collectFromTasks(app, cfg, sourcePath) {
	const items = [];
	const stats = { taskFilesScanned: 0, tasksSeen: 0, tasksWithDates: 0 };

	for (const file of app.vault.getMarkdownFiles()) {
		if (!inScope(file, cfg, sourcePath)) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (!cache || !Array.isArray(cache.listItems)) continue;
		if (!cache.listItems.some((li) => li.task != null)) continue;
		if (cfg.tags.length && !matchesTag(fileTags(cache), cfg.tags)) continue;

		stats.taskFilesScanned++;

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
			stats.tasksSeen++;

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
			stats.tasksWithDates++;

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
	return { items, stats };
}

/*
 * Give every item a concrete span.
 * An item with only one date becomes a milestone rather than a zero-width bar.
 */
function normaliseSpans(items) {
	for (const it of items) {
		const end = it.end || it.done;
		if (it.start && end) {
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

function tickLabel(kind, date) {
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
 * Empty-state diagnosis
 *
 * An empty chart is almost always one of a few specific problems. Say which
 * one rather than printing "no results".
 * ------------------------------------------------------------------ */

function explainEmpty(box, cfg, stats, s) {
	const startField = cfg.startField || s.startField;
	const endField = cfg.endField || s.endField;

	el('div', 'wgantt-empty-title', box, 'Nothing to chart');
	const why = el('div', 'wgantt-empty-why', box);

	if (stats.inScope === 0) {
		el('p', null, why, cfg.file
			? `No note matched "file: ${cfg.file}".`
			: `No notes found under "${cfg.folder || '/'}". Check the folder path.`);
	} else if (stats.withFrontmatter === 0) {
		el('p', null, why, `${stats.inScope} note(s) in scope, but none have YAML frontmatter.`);
	} else if (stats.withDates === 0) {
		el('p', null, why,
			`${stats.withFrontmatter} note(s) in scope have frontmatter, but none has a ` +
			`value in "${startField}" or "${endField}".`);
		el('p', null, why, 'A field that exists but is empty does not count. It needs a date:');
		const pre = el('pre', 'wgantt-empty-code', why);
		el('code', null, pre, `---\n${startField}: 2026-09-03\n${endField}: 2026-12-19\n---`);
	} else if (stats.filteredOut > 0) {
		el('p', null, why,
			`${stats.withDates} note(s) had dates, but all were removed by the ` +
			'status or tag filter on this block.');
	} else {
		el('p', null, why, 'Items were found but fell outside the from/to window.');
	}
}

/* ------------------------------------------------------------------ *
 * The chart builder - shared by the code block and the view
 * ------------------------------------------------------------------ */

async function buildChart(root, plugin, cfg, sourcePath) {
	root.textContent = '';

	const s = plugin.settings;
	const scaleName = cfg.scale || s.defaultScale;
	const scale = SCALES[scaleName] || SCALES.week;

	let items = [];
	let stats = { scanned: 0, inScope: 0, withFrontmatter: 0, withDates: 0, filteredOut: 0 };

	try {
		if (cfg.source === 'notes' || cfg.source === 'both') {
			const r = collectFromNotes(plugin.app, cfg, s, sourcePath);
			items = items.concat(r.items);
			stats = r.stats;
		}
		if (cfg.source === 'tasks' || cfg.source === 'both') {
			const r = await collectFromTasks(plugin.app, cfg, sourcePath);
			items = items.concat(r.items);
			Object.assign(stats, r.stats);
			if (cfg.source === 'tasks') {
				stats.inScope = r.stats.taskFilesScanned;
				stats.withFrontmatter = r.stats.tasksSeen;
				stats.withDates = r.stats.tasksWithDates;
			}
		}
	} catch (e) {
		const box = el('div', 'wgantt-error', root);
		el('div', 'wgantt-error-title', box, 'Gantt failed to read notes');
		el('div', null, box, String(e && e.message ? e.message : e));
		return 0;
	}

	normaliseSpans(items);
	if (cfg.from) items = items.filter((i) => i.spanEnd >= cfg.from);
	if (cfg.to) items = items.filter((i) => i.spanStart <= cfg.to);

	sortItems(items, cfg);
	if (cfg.limit) items = items.slice(0, cfg.limit);

	if (cfg.title) el('div', 'wgantt-title', root, cfg.title);

	if (!items.length) {
		explainEmpty(el('div', 'wgantt-empty', root), cfg, stats, s);
		return 0;
	}

	let rangeStart = cfg.from || items.reduce((a, i) => (i.spanStart < a ? i.spanStart : a), items[0].spanStart);
	let rangeEnd = cfg.to || items.reduce((a, i) => (i.spanEnd > a ? i.spanEnd : a), items[0].spanEnd);

	const pad = scaleName === 'day' ? 1 : scaleName === 'week' ? 3 : 14;
	rangeStart = addDays(rangeStart, -pad);
	rangeEnd = addDays(rangeEnd, pad);

	const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
	const pxPerDay = scale.pxPerDay;
	const canvasWidth = Math.max(totalDays * pxPerDay, 200);
	const x = (d) => daysBetween(rangeStart, d) * pxPerDay;

	const info = el('div', 'wgantt-toolbar', root);
	el('span', 'wgantt-count', info, `${items.length} item${items.length === 1 ? '' : 's'}`);
	el('span', 'wgantt-scalename', info, scaleName);

	const body = el('div', 'wgantt-body', root);
	body.style.setProperty('--wg-label-width', s.labelWidth + 'px');
	body.style.setProperty('--wg-row-height', s.rowHeight + 'px');
	body.style.setProperty('--wg-bar-height', s.barHeight + 'px');

	const labels = el('div', 'wgantt-labels', body);
	const scroll = el('div', 'wgantt-scroll', body);
	const canvas = el('div', 'wgantt-canvas', scroll);
	canvas.style.width = canvasWidth + 'px';

	el('div', 'wgantt-labels-head', labels);
	buildAxis(canvas, scale, rangeStart, rangeEnd, x, s.weekStart);

	const grid = el('div', 'wgantt-grid', canvas);
	const rows = el('div', 'wgantt-rows', canvas);

	for (const t of stepStarts(scale.minor, rangeStart, rangeEnd, s.weekStart)) {
		if (t < rangeStart) continue;
		const line = el('div', 'wgantt-gridline', grid);
		line.style.left = x(t) + 'px';
	}

	buildRows(plugin, labels, rows, items, cfg, x, pxPerDay);

	const showToday = cfg.showToday == null ? s.showToday : cfg.showToday;
	const t = today();
	if (showToday && t >= rangeStart && t <= rangeEnd) {
		const line = el('div', 'wgantt-today', canvas);
		line.style.left = x(t) + 'px';
		line.title = 'Today - ' + isoDate(t);
	}

	if (t >= rangeStart && t <= rangeEnd) {
		window.setTimeout(() => {
			scroll.scrollLeft = Math.max(0, x(t) - scroll.clientWidth / 2);
		}, 0);
	}

	return items.length;
}

function buildAxis(canvas, scale, rangeStart, rangeEnd, x, weekStart) {
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
		const cell = el('div', 'wgantt-minor-cell', minorRow, tickLabel(scale.minor, d));
		cell.style.left = x(d) + 'px';
		const next = minors[i + 1];
		if (next) cell.style.width = Math.max(x(next) - x(d), 0) + 'px';
		if (scale.minor === 'day') {
			const dow = d.getDay();
			if (dow === 0 || dow === 6) cell.classList.add('is-weekend');
		}
	}
}

function openItem(plugin, item) {
	const newPane = plugin.settings.openInNewPane;
	plugin.app.workspace.openLinkText(item.path, '', newPane).then(() => {
		if (item.line == null) return;
		const view = plugin.app.workspace.getActiveViewOfType(require('obsidian').MarkdownView);
		if (view && view.editor) {
			view.editor.setCursor({ line: item.line, ch: 0 });
			view.editor.scrollIntoView(
				{ from: { line: item.line, ch: 0 }, to: { line: item.line, ch: 0 } }, true
			);
		}
	}).catch(() => { /* file may have been removed since render */ });
}

function buildRows(plugin, labels, rows, items, cfg, x, pxPerDay) {
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

		const label = el('div', 'wgantt-label', labels);
		const link = el('span', 'wgantt-label-text', label, item.title);
		link.title = item.path + (item.line != null ? `:${item.line + 1}` : '');
		label.addEventListener('click', () => openItem(plugin, item));

		if (item.status) {
			const dot = el('span', 'wgantt-dot', label);
			dot.style.background = STATUS_COLORS[item.status] || 'var(--interactive-accent)';
			dot.title = item.status;
		}

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
			bar.style.width = Math.max((daysBetween(item.spanStart, item.spanEnd) + 1) * pxPerDay, 3) + 'px';
			bar.style.background = colour;
			if (item.status === 'completed' || item.status === 'done') bar.classList.add('is-done');
			if (item.reversed) bar.classList.add('is-reversed');
			if (parseFloat(bar.style.width) > 60) el('span', 'wgantt-bar-text', bar, item.title);
		}

		const span = item.milestone
			? isoDate(item.spanStart)
			: `${isoDate(item.spanStart)} to ${isoDate(item.spanEnd)}`;
		bar.title = `${item.title}\n${span}${item.status ? '\n' + item.status : ''}` +
			(item.reversed ? '\n(dates were reversed in the note)' : '');
		bar.addEventListener('click', () => openItem(plugin, item));
	}
}

/* ------------------------------------------------------------------ *
 * Code block
 * ------------------------------------------------------------------ */

class GanttBlock extends MarkdownRenderChild {
	constructor(containerEl, plugin, source, sourcePath) {
		super(containerEl);
		this.plugin = plugin;
		this.source = source;
		this.sourcePath = sourcePath;
		this.refreshTimer = null;
	}

	onload() {
		this.render();
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
		root.className = 'wgantt';
		const { cfg, errors } = parseConfig(this.source);

		if (errors.length) {
			root.textContent = '';
			const box = el('div', 'wgantt-error', root);
			el('div', 'wgantt-error-title', box, 'Gantt block has errors');
			const ul = el('ul', null, box);
			for (const e of errors) el('li', null, ul, e);
			return;
		}
		await buildChart(root, this.plugin, cfg, this.sourcePath);
	}
}

/* ------------------------------------------------------------------ *
 * The view - what the ribbon icon opens
 * ------------------------------------------------------------------ */

class GanttView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.refreshTimer = null;
	}

	getViewType() { return VIEW_TYPE_GANTT; }
	getDisplayText() { return 'Gantt calendar'; }
	getIcon() { return RIBBON_ICON; }

	async onOpen() {
		const s = this.plugin.settings;
		this.cfg = defaultConfig();
		this.cfg.folder = s.viewFolder;
		this.cfg.scale = s.viewScale;
		this.cfg.group = s.viewGroup;
		this.cfg.sort = s.viewSort;

		const container = this.contentEl;
		container.empty();
		container.addClass('wgantt-view');

		this.controls = el('div', 'wgantt-controls', container);
		this.chartEl = el('div', 'wgantt', container);

		this.buildControls();
		await this.refresh();

		const schedule = () => {
			if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
			this.refreshTimer = window.setTimeout(() => {
				this.refreshTimer = null;
				this.refresh();
			}, 600);
		};
		this.registerEvent(this.app.metadataCache.on('changed', schedule));
		this.registerEvent(this.app.vault.on('delete', schedule));
		this.registerEvent(this.app.vault.on('rename', schedule));
	}

	async onClose() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
	}

	buildControls() {
		const c = this.controls;
		c.textContent = '';

		const folders = ['']
			.concat(this.app.vault.getAllLoadedFiles()
				.filter((f) => f.children && f.path !== '/')
				.map((f) => f.path)
				.sort());

		this.select(c, 'Folder', folders.map((f) => [f, f || 'Whole vault']), this.cfg.folder, async (v) => {
			this.cfg.folder = v;
			this.plugin.settings.viewFolder = v;
			await this.plugin.saveSettings();
			this.refresh();
		});

		this.select(c, 'Scale', Object.keys(SCALES).map((k) => [k, k]), this.cfg.scale, async (v) => {
			this.cfg.scale = v;
			this.plugin.settings.viewScale = v;
			await this.plugin.saveSettings();
			this.refresh();
		});

		this.select(c, 'Sort', [['start', 'Start date'], ['end', 'End date'], ['title', 'Title'], ['status', 'Status']],
			this.cfg.sort, async (v) => {
				this.cfg.sort = v;
				this.plugin.settings.viewSort = v;
				await this.plugin.saveSettings();
				this.refresh();
			});

		this.select(c, 'Group', [['', 'None'], ['folder', 'Folder'], ['company', 'Company'], ['type', 'Type'], ['status', 'Status']],
			this.cfg.group, async (v) => {
				this.cfg.group = v;
				this.plugin.settings.viewGroup = v;
				await this.plugin.saveSettings();
				this.refresh();
			});

		const btn = el('button', 'wgantt-btn', c, 'Refresh');
		btn.addEventListener('click', () => this.refresh());
	}

	select(parent, label, options, value, onChange) {
		const wrap = el('label', 'wgantt-control', parent);
		el('span', 'wgantt-control-label', wrap, label);
		const sel = el('select', 'wgantt-select', wrap);
		for (const [val, text] of options) {
			const o = el('option', null, sel, text);
			o.value = val;
			if (val === value) o.selected = true;
		}
		sel.addEventListener('change', () => onChange(sel.value));
		return sel;
	}

	async refresh() {
		await buildChart(this.chartEl, this.plugin, this.cfg, null);
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
			ctx.addChild(new GanttBlock(elParent, this, source, ctx.sourcePath));
		});

		this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));

		this.addRibbonIcon(RIBBON_ICON, 'Open Gantt calendar', () => { this.activateView(); });

		this.addCommand({
			id: 'open-gantt-view',
			name: 'Open Gantt calendar',
			callback: () => { this.activateView(); },
		});

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

		this.addSettingTab(new GanttSettingTab(this.app, this));
	}

	async activateView() {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_GANTT);
		if (existing.length) {
			workspace.revealLeaf(existing[0]);
			return;
		}
		// A Gantt chart needs width, so it opens as a main-area tab rather
		// than in the narrow right sidebar.
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_GANTT, active: true });
		workspace.revealLeaf(leaf);
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
	parseConfig, defaultConfig, normaliseSpans, sortItems, stepStarts,
	matchesTag, inScope, tickLabel, majorLabel,
	SCALES, STATUS_COLORS, DEFAULT_SETTINGS, VIEW_TYPE_GANTT, RIBBON_ICON,
};
