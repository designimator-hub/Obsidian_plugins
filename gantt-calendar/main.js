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
 *
 * On writing to your vault:
 *   This plugin DOES modify notes, and only in these three ways:
 *     1. creating a new note when you use "New project"
 *     2. setting start_date / due_date when you drag a bar or edit dates
 *     3. setting status and completed_date when you use the done toggle
 *   All frontmatter edits go through app.fileManager.processFrontMatter,
 *   which rewrites only the YAML block and leaves note bodies untouched.
 *   Nothing is ever deleted. Set "Allow editing" off in settings, or put
 *   readonly: true in a block, to make the plugin read-only again.
 *
 * Two ways in:
 *   - a ```gantt code block in any note
 *   - the ribbon icon / "Open Gantt calendar" command, which opens a
 *     vault-wide chart with its own controls
 */

const {
	Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView, Modal, Notice,
} = require('obsidian');

const VIEW_TYPE_GANTT = 'wright-gantt-view';
const RIBBON_ICON = 'calendar-range';

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/* Bumped when a stored settings shape needs migrating. See migrateSettings. */
const SETTINGS_VERSION = 2;

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
	// Editing
	allowEditing: true,
	newProjectFolder: '03_Projects/Active',
	viewHideFinished: false,
	settingsVersion: SETTINGS_VERSION,
	newProjectType: 'project',
	// Remembered state for the sidebar view.
	viewFolder: '03_Projects',
	viewScale: 'month',
	viewGroup: '',
	viewSort: 'start',
};

/* Statuses offered in the editing controls. */
const STATUS_CHOICES = [
	'active', 'proposed', 'planned', 'review', 'waiting', 'paused',
	'completed', 'finished', 'cancelled', 'reference', 'evergreen',
];

/*
 * Settings migrations.
 *
 * Version 2: the view used to default to 03_Projects/Active, which silently
 * excluded every proposed and completed project - the chart looked like it
 * was working while hiding most of the data. Widen it to the parent folder
 * once, for anyone carrying the old value.
 *
 * A deliberately explicit value is left alone; only the old default is
 * rewritten. Pure so it can be tested.
 */
function migrateSettings(stored) {
	const s = Object.assign({}, stored || {});
	const from = s.settingsVersion || 1;

	if (from < 2) {
		if (s.viewFolder === '03_Projects/Active') s.viewFolder = '03_Projects';
	}

	s.settingsVersion = SETTINGS_VERSION;
	return s;
}

/*
 * Statuses that count as finished for the "hide finished" toggle.
 *
 * "finished" is here because that is the word the toggle uses, and people
 * reasonably type it into the note. Leaving it out meant a note marked
 * Finished was not hidden by the control that says it hides finished work.
 * Comparison is case-insensitive, so "Finished" matches too.
 */
const FINISHED_STATUSES = ['completed', 'done', 'finished'];

function isFinished(status) {
	return FINISHED_STATUSES.includes(String(status || '').toLowerCase());
}

/* Zoom steps, coarsest last. */
const SCALE_ORDER = ['day', 'week', 'month', 'quarter'];

function zoomScale(current, direction) {
	const i = SCALE_ORDER.indexOf(current);
	if (i === -1) return current;
	const next = i + (direction === 'in' ? -1 : 1);
	if (next < 0 || next >= SCALE_ORDER.length) return current;
	return SCALE_ORDER[next];
}

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
	finished: 'var(--text-faint)',
	review: 'var(--color-pink)',
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
	'show-today', 'readonly', 'hide-finished',
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
		readonly: false,
		hideFinished: false,
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
			case 'readonly': cfg.readonly = !/^(false|no|0)$/i.test(value); break;
			case 'hide-finished': cfg.hideFinished = !/^(false|no|0)$/i.test(value); break;
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
		withDates: 0, filteredOut: 0, finishedHidden: 0,
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
		if (cfg.hideFinished && isFinished(status)) { stats.finishedHidden++; continue; }
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
			// Which fields actually exist decides what a drag writes back.
			hasStart: !!start,
			hasEnd: !!end,
			startField, endField, doneField, statusField,
			editable: true,
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
			if (cfg.hideFinished && isFinished(status)) continue;
			if (cfg.status.length && !cfg.status.includes(status)) continue;
			if (cfg.excludeStatus.length && cfg.excludeStatus.includes(status)) continue;

			items.push({
				title: body || '(untitled task)',
				start, end, done, status,
				group: cfg.group === 'folder' ? (file.parent ? file.parent.path : '/') : (cfg.group ? file.basename : ''),
				path: file.path,
				line: lineNo,
				hasStart: !!start,
				hasEnd: !!end,
				// Editing a task line means rewriting inline markup rather than
				// YAML. Not attempted; open the note instead.
				editable: false,
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
 * Editing - pure logic
 * ------------------------------------------------------------------ */

/*
 * Work out the new span after a drag.
 *   mode 'move'  - shift both ends
 *   mode 'start' - move the left edge, never past the right
 *   mode 'end'   - move the right edge, never before the left
 * Returns fresh Date objects; the inputs are not mutated.
 */
function shiftSpan(mode, start, end, dayDelta) {
	let s = new Date(start.getTime());
	let e = new Date(end.getTime());

	if (mode === 'move') {
		s = addDays(s, dayDelta);
		e = addDays(e, dayDelta);
	} else if (mode === 'start') {
		s = addDays(s, dayDelta);
		if (s > e) s = new Date(e.getTime());
	} else if (mode === 'end') {
		e = addDays(e, dayDelta);
		if (e < s) e = new Date(s.getTime());
	}
	return { start: s, end: e };
}

/*
 * Decide which frontmatter keys a drag should write.
 * A milestone with only a due date must not silently gain a start date.
 */
function dragWrites(item, mode, span) {
	const out = {};
	const bothPresent = item.hasStart && item.hasEnd;

	if (mode === 'move') {
		if (bothPresent) {
			out[item.startField] = isoDate(span.start);
			out[item.endField] = isoDate(span.end);
		} else if (item.hasStart) {
			out[item.startField] = isoDate(span.start);
		} else {
			out[item.endField] = isoDate(span.end);
		}
	} else if (mode === 'start') {
		out[item.startField] = isoDate(span.start);
	} else if (mode === 'end') {
		out[item.endField] = isoDate(span.end);
	}
	return out;
}

/* Which way the done toggle goes, and what it writes. */
function doneToggleWrites(item, todayIso) {
	const isDone = isFinished(item.status);
	if (isDone) {
		return { changes: { [item.statusField]: 'active', [item.doneField]: null }, nowDone: false };
	}
	return { changes: { [item.statusField]: 'completed', [item.doneField]: todayIso }, nowDone: true };
}

/* Turn a title into a filename that Obsidian will accept. */
function safeFileName(title) {
	return String(title)
		.replace(/[\\/:*?"<>|#^[\]]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.slice(0, 120);
}

function newProjectContent(data) {
	const lines = [
		'---',
		'type: ' + (data.type || 'project'),
		'status: ' + (data.status || 'proposed'),
		'importance: medium',
		'created: ' + data.todayIso,
		'updated: ' + data.todayIso,
	];
	if (data.owner) lines.push('owner: ' + data.owner);
	if (data.company) lines.push('company: ' + data.company);
	lines.push('start_date: ' + (data.start || ''));
	lines.push('due_date: ' + (data.due || ''));
	lines.push('completed_date:');
	lines.push('people: []');
	lines.push('domains: []');
	lines.push('tags:');
	lines.push('  - project');
	lines.push('---');
	lines.push('');
	lines.push('# ' + data.title);
	lines.push('');
	lines.push('## Outcome');
	lines.push('');
	lines.push(data.outcome || 'State the finished result in one or two sentences.');
	lines.push('');
	lines.push('## Next actions');
	lines.push('');
	lines.push('- [ ] ');
	lines.push('');
	return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Editing - vault writes
 *
 * processFrontMatter rewrites only the YAML block. Note bodies are never
 * touched, and nothing is ever deleted.
 * ------------------------------------------------------------------ */

async function applyFrontmatter(app, path, changes) {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) throw new Error('Note not found: ' + path);

	await app.fileManager.processFrontMatter(file, (fm) => {
		for (const key of Object.keys(changes)) {
			const value = changes[key];
			if (value === null) delete fm[key];
			else fm[key] = value;
		}
		fm.updated = isoDate(today());
	});
}

async function createProjectNote(app, data) {
	const folder = String(data.folder || '').replace(/^\/+|\/+$/g, '');
	const name = safeFileName(data.title);
	if (!name) throw new Error('The project needs a name.');

	const path = (folder ? folder + '/' : '') + name + '.md';
	if (app.vault.getAbstractFileByPath(path)) {
		throw new Error('A note already exists at ' + path);
	}
	if (folder && !app.vault.getAbstractFileByPath(folder)) {
		await app.vault.createFolder(folder);
	}
	return app.vault.create(path, newProjectContent(data));
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
	} else if (stats.finishedHidden > 0 && stats.filteredOut === 0) {
		el('p', null, why,
			`${stats.finishedHidden} note(s) had dates but are finished, and ` +
			'"Hide finished" is on.');
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

async function buildChart(root, plugin, cfg, sourcePath, onChange, onScaleChange) {
	root.textContent = '';

	const s = plugin.settings;
	const editable = s.allowEditing && !cfg.readonly;
	const refresh = onChange || (() => {});
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
		const box = el('div', 'wgantt-empty', root);
		explainEmpty(box, cfg, stats, s);
		if (editable) {
			const b = el('button', 'wgantt-btn', box, '+ New project');
			b.addEventListener('click', () => new NewProjectModal(plugin.app, plugin, refresh).open());
		}
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

	// Toolbar is created first so it sits at the top, but its buttons are
	// wired after the scroller exists below.
	const info = el('div', 'wgantt-toolbar', root);

	/*
	 * One scroll container for both axes. The header row and the label
	 * column are sticky inside it, so they stay put while the timeline
	 * moves under them. An earlier version scrolled the two axes in
	 * separate elements, which broke the sticky header on vertical scroll.
	 */
	const body = el('div', 'wgantt-body', root);
	body.style.setProperty('--wg-label-width', s.labelWidth + 'px');
	body.style.setProperty('--wg-row-height', s.rowHeight + 'px');
	body.style.setProperty('--wg-bar-height', s.barHeight + 'px');
	body.tabIndex = 0; // so arrow keys and Home/End reach it

	/*
	 * Structure matters here, and a CSS grid does not work.
	 *
	 * A sticky element can only slide within its containing block, and for a
	 * grid item the containing block is its own grid area. Each item exactly
	 * filled its area, so there was nowhere to slide and both the frozen
	 * header and the frozen label column silently did nothing.
	 *
	 * Instead: two full-width flex rows inside a wrapper as wide as the whole
	 * chart. The header row is sticky inside the tall wrapper, so it has room
	 * to slide down; the corner and label column are sticky inside full-width
	 * rows, so they have room to slide right.
	 */
	const totalWidth = s.labelWidth + canvasWidth;

	const inner = el('div', 'wgantt-inner', body);
	inner.style.width = totalWidth + 'px';

	const headRow = el('div', 'wgantt-headrow', inner);
	headRow.style.width = totalWidth + 'px';
	el('div', 'wgantt-corner', headRow);
	const head = el('div', 'wgantt-head', headRow);
	head.style.width = canvasWidth + 'px';

	const rowsArea = el('div', 'wgantt-rowsarea', inner);
	rowsArea.style.width = totalWidth + 'px';
	const labels = el('div', 'wgantt-labels', rowsArea);
	const canvas = el('div', 'wgantt-canvas', rowsArea);
	canvas.style.width = canvasWidth + 'px';

	buildAxis(head, scale, rangeStart, rangeEnd, x, s.weekStart);

	const grid = el('div', 'wgantt-grid', canvas);
	const rows = el('div', 'wgantt-rows', canvas);

	for (const t of stepStarts(scale.minor, rangeStart, rangeEnd, s.weekStart)) {
		if (t < rangeStart) continue;
		const line = el('div', 'wgantt-gridline', grid);
		line.style.left = x(t) + 'px';
	}

	buildRows(plugin, labels, rows, items, cfg, x, pxPerDay, editable, refresh);

	const showToday = cfg.showToday == null ? s.showToday : cfg.showToday;
	const t = today();
	const todayVisible = t >= rangeStart && t <= rangeEnd;
	if (showToday && todayVisible) {
		const line = el('div', 'wgantt-today', canvas);
		line.style.left = x(t) + 'px';
		line.title = 'Today - ' + isoDate(t);
	}

	const centreOn = (date) => {
		body.scrollLeft = Math.max(0, x(date) - body.clientWidth / 2 + s.labelWidth / 2);
	};

	attachPanning(body, canvas);

	/* ---- toolbar ---- */

	if (editable) {
		const b = el('button', 'wgantt-btn wgantt-btn-cta', info, '+ New project');
		b.title = 'Create a new project note and put it on the chart';
		b.addEventListener('click', () => new NewProjectModal(plugin.app, plugin, refresh).open());
	}

	if (todayVisible) {
		const b = el('button', 'wgantt-btn wgantt-btn-small', info, 'Today');
		b.title = 'Scroll the timeline back to today';
		b.addEventListener('click', () => centreOn(t));
	}

	const zoom = el('div', 'wgantt-zoom', info);
	const zoomOut = el('button', 'wgantt-btn wgantt-btn-icon', zoom, '−');
	zoomOut.title = 'Zoom out - show a longer span';
	zoomOut.disabled = scaleName === SCALE_ORDER[SCALE_ORDER.length - 1];
	zoomOut.addEventListener('click', () => onScaleChange && onScaleChange(zoomScale(scaleName, 'out')));

	el('span', 'wgantt-scalename', zoom, scaleName);

	const zoomIn = el('button', 'wgantt-btn wgantt-btn-icon', zoom, '+');
	zoomIn.title = 'Zoom in - show more detail';
	zoomIn.disabled = scaleName === SCALE_ORDER[0];
	zoomIn.addEventListener('click', () => onScaleChange && onScaleChange(zoomScale(scaleName, 'in')));

	const scope = el('span', 'wgantt-count', info,
		`${items.length} item${items.length === 1 ? '' : 's'}` +
		(cfg.folder ? ` in ${cfg.folder}` : ' (whole vault)') +
		(cfg.hideFinished ? ', finished hidden' : ''));
	scope.title = 'What this chart is currently showing';

	if (todayVisible) window.setTimeout(() => centreOn(t), 0);

	return items.length;
}

/*
 * Scrolling around the chart.
 *
 * Three ways to move, because a wide timeline in a narrow pane is
 * genuinely awkward with a scrollbar alone:
 *   - drag any empty part of the chart to pan in both directions
 *   - shift + wheel scrolls horizontally
 *   - arrow keys, Home and End, when the chart has focus
 *
 * Dragging is only started from the background. Bars keep their own drag
 * behaviour, so panning never fights rescheduling.
 */
function attachPanning(scroller, canvas) {
	const isBackground = (target) =>
		target === canvas ||
		target.classList.contains('wgantt-grid') ||
		target.classList.contains('wgantt-gridline') ||
		target.classList.contains('wgantt-rows') ||
		target.classList.contains('wgantt-row');

	canvas.addEventListener('mousedown', (ev) => {
		if (ev.button !== 0 || !isBackground(ev.target)) return;
		ev.preventDefault();

		const startX = ev.clientX;
		const startY = ev.clientY;
		const startLeft = scroller.scrollLeft;
		const startTop = scroller.scrollTop;
		canvas.classList.add('is-panning');

		const onMove = (e) => {
			scroller.scrollLeft = startLeft - (e.clientX - startX);
			scroller.scrollTop = startTop - (e.clientY - startY);
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			canvas.classList.remove('is-panning');
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});

	scroller.addEventListener('wheel', (ev) => {
		if (!ev.shiftKey) return;
		const delta = ev.deltaY || ev.deltaX;
		if (!delta) return;
		ev.preventDefault();
		scroller.scrollLeft += delta;
	}, { passive: false });

	scroller.addEventListener('keydown', (ev) => {
		const step = ev.ctrlKey ? scroller.clientWidth : 80;
		let handled = true;
		if (ev.key === 'ArrowRight') scroller.scrollLeft += step;
		else if (ev.key === 'ArrowLeft') scroller.scrollLeft -= step;
		else if (ev.key === 'ArrowDown') scroller.scrollTop += 60;
		else if (ev.key === 'ArrowUp') scroller.scrollTop -= 60;
		else if (ev.key === 'Home') scroller.scrollLeft = 0;
		else if (ev.key === 'End') scroller.scrollLeft = scroller.scrollWidth;
		else handled = false;
		if (handled) ev.preventDefault();
	});
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

function buildRows(plugin, labels, rows, items, cfg, x, pxPerDay, editable, onChange) {
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

		const canEdit = editable && item.editable;

		const label = el('div', 'wgantt-label', labels);

		if (item.status) {
			const dot = el('span', 'wgantt-dot', label);
			dot.style.background = STATUS_COLORS[item.status] || 'var(--interactive-accent)';
			dot.title = item.status;
		}

		const link = el('span', 'wgantt-label-text', label, item.title);
		link.title = item.path + (item.line != null ? `:${item.line + 1}` : '');
		link.addEventListener('click', () => openItem(plugin, item));

		if (canEdit) {
			const isDone = isFinished(item.status);

			const doneBtn = el('button', 'wgantt-row-btn wgantt-done-btn', label, isDone ? '↺' : '✓');
			doneBtn.title = isDone
				? 'Reopen - set status back to active and clear the completion date'
				: 'Done - set status to completed and stamp today as the completion date';
			if (isDone) doneBtn.classList.add('is-done');
			doneBtn.addEventListener('click', async (ev) => {
				ev.stopPropagation();
				const { changes, nowDone } = doneToggleWrites(item, isoDate(today()));
				try {
					await applyFrontmatter(plugin.app, item.path, changes);
					new Notice(`${item.title} - ${nowDone ? 'marked done' : 'reopened'}`);
					if (onChange) onChange();
				} catch (e) {
					new Notice('Could not update: ' + (e && e.message ? e.message : e));
				}
			});

			const editBtn = el('button', 'wgantt-row-btn', label, '✎');
			editBtn.title = 'Edit dates and status';
			editBtn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				new EditDatesModal(plugin.app, item, onChange).open();
			});
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
			if (isFinished(item.status)) bar.classList.add('is-done');
			if (item.reversed) bar.classList.add('is-reversed');
			if (parseFloat(bar.style.width) > 60) el('span', 'wgantt-bar-text', bar, item.title);
		}

		const span = item.milestone
			? isoDate(item.spanStart)
			: `${isoDate(item.spanStart)} to ${isoDate(item.spanEnd)}`;
		bar.title = `${item.title}\n${span}${item.status ? '\n' + item.status : ''}` +
			(item.reversed ? '\n(dates were reversed in the note)' : '') +
			(canEdit ? '\n\nDrag to move. Drag an edge to resize.' : '');

		if (canEdit) {
			bar.classList.add('is-editable');
			attachDrag(plugin, bar, item, pxPerDay, onChange);
		} else {
			bar.addEventListener('click', () => openItem(plugin, item));
		}
	}
}

/*
 * Drag a bar to reschedule.
 *
 * The gesture is previewed by moving the element, and only written to the
 * note on release. A gesture that moves less than DRAG_THRESHOLD pixels is
 * treated as a click, so clicking a bar still opens the note.
 */
const DRAG_THRESHOLD = 4;
const EDGE_ZONE = 7;

function attachDrag(plugin, bar, item, pxPerDay, onChange) {
	const isMilestone = item.milestone;

	if (!isMilestone) {
		bar.addEventListener('mousemove', (ev) => {
			if (bar.dataset.dragging === '1') return;
			const rect = bar.getBoundingClientRect();
			const offset = ev.clientX - rect.left;
			if (offset < EDGE_ZONE || offset > rect.width - EDGE_ZONE) bar.style.cursor = 'ew-resize';
			else bar.style.cursor = 'grab';
		});
	}

	bar.addEventListener('mousedown', (ev) => {
		if (ev.button !== 0) return;
		ev.preventDefault();

		const rect = bar.getBoundingClientRect();
		const offset = ev.clientX - rect.left;

		let mode = 'move';
		if (!isMilestone) {
			if (offset < EDGE_ZONE) mode = 'start';
			else if (offset > rect.width - EDGE_ZONE) mode = 'end';
		}

		const startX = ev.clientX;
		const originalLeft = parseFloat(bar.style.left) || 0;
		const originalWidth = parseFloat(bar.style.width) || 0;
		let moved = false;
		let dayDelta = 0;

		bar.dataset.dragging = '1';
		bar.classList.add('is-dragging');
		document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';

		const onMove = (e) => {
			const dx = e.clientX - startX;
			if (Math.abs(dx) > DRAG_THRESHOLD) moved = true;
			dayDelta = Math.round(dx / pxPerDay);
			const snapped = dayDelta * pxPerDay;

			if (mode === 'move') {
				bar.style.left = (originalLeft + snapped) + 'px';
			} else if (mode === 'start') {
				const w = Math.max(originalWidth - snapped, pxPerDay);
				bar.style.left = (originalLeft + (originalWidth - w)) + 'px';
				bar.style.width = w + 'px';
			} else {
				bar.style.width = Math.max(originalWidth + snapped, pxPerDay) + 'px';
			}
		};

		const onUp = async () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			document.body.style.cursor = '';
			bar.dataset.dragging = '0';
			bar.classList.remove('is-dragging');

			if (!moved) {
				// Restore, then treat as a plain click.
				bar.style.left = originalLeft + 'px';
				if (originalWidth) bar.style.width = originalWidth + 'px';
				openItem(plugin, item);
				return;
			}
			if (dayDelta === 0) {
				bar.style.left = originalLeft + 'px';
				if (originalWidth) bar.style.width = originalWidth + 'px';
				return;
			}

			const span = shiftSpan(mode, item.spanStart, item.spanEnd, dayDelta);
			const changes = dragWrites(item, mode, span);

			try {
				await applyFrontmatter(plugin.app, item.path, changes);
				const parts = Object.keys(changes).map((k) => `${k} ${changes[k]}`);
				new Notice(`${item.title} - ${parts.join(', ')}`);
				if (onChange) onChange();
			} catch (e) {
				bar.style.left = originalLeft + 'px';
				if (originalWidth) bar.style.width = originalWidth + 'px';
				new Notice('Could not update: ' + (e && e.message ? e.message : e));
			}
		};

		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

class NewProjectModal extends Modal {
	constructor(app, plugin, onDone) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
		const t = isoDate(today());
		this.data = {
			title: '',
			folder: plugin.settings.newProjectFolder,
			type: plugin.settings.newProjectType,
			status: 'proposed',
			start: t,
			due: isoDate(addDays(today(), 30)),
			owner: '',
			company: '',
			outcome: '',
			todayIso: t,
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wgantt-modal');
		contentEl.createEl('h3', { text: 'New project' });

		const bind = (key) => async (v) => { this.data[key] = v.trim(); };

		new Setting(contentEl).setName('Name').setDesc('Becomes the note filename.')
			.addText((t) => t.setPlaceholder('Shinagawa 3F Fit-out').onChange(bind('title')));

		new Setting(contentEl).setName('Folder')
			.addText((t) => t.setValue(this.data.folder).onChange(bind('folder')));

		new Setting(contentEl).setName('Status')
			.addDropdown((d) => {
				for (const s of STATUS_CHOICES) d.addOption(s, s);
				d.setValue(this.data.status).onChange((v) => { this.data.status = v; });
			});

		new Setting(contentEl).setName('Start date').setDesc('YYYY-MM-DD. Leave blank for none.')
			.addText((t) => t.setValue(this.data.start).onChange(bind('start')));

		new Setting(contentEl).setName('Due date')
			.addText((t) => t.setValue(this.data.due).onChange(bind('due')));

		new Setting(contentEl).setName('Owner')
			.addText((t) => t.setPlaceholder('optional').onChange(bind('owner')));

		new Setting(contentEl).setName('Company or client')
			.addText((t) => t.setPlaceholder('optional').onChange(bind('company')));

		const err = contentEl.createDiv({ cls: 'wgantt-modal-error' });

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText('Create').setCta().onClick(async () => {
				err.textContent = '';
				const problems = [];
				if (!this.data.title.trim()) problems.push('A name is required.');
				if (this.data.start && !parseDate(this.data.start)) problems.push('Start date must be YYYY-MM-DD.');
				if (this.data.due && !parseDate(this.data.due)) problems.push('Due date must be YYYY-MM-DD.');
				const s = parseDate(this.data.start), d = parseDate(this.data.due);
				if (s && d && s > d) problems.push('Start is later than due.');
				if (problems.length) { err.textContent = problems.join(' '); return; }

				try {
					const file = await createProjectNote(this.app, this.data);
					new Notice('Created ' + file.path);
					this.close();
					if (this.onDone) this.onDone(file);
				} catch (e) {
					err.textContent = String(e && e.message ? e.message : e);
				}
			}));
	}

	onClose() { this.contentEl.empty(); }
}

class EditDatesModal extends Modal {
	constructor(app, item, onDone) {
		super(app);
		this.item = item;
		this.onDone = onDone;
		this.values = {
			start: item.hasStart ? isoDate(item.start) : '',
			due: item.hasEnd ? isoDate(item.end) : '',
			status: item.status || '',
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wgantt-modal');
		contentEl.createEl('h3', { text: this.item.title });
		contentEl.createEl('p', { cls: 'wgantt-modal-path', text: this.item.path });

		new Setting(contentEl).setName('Start date').setDesc('YYYY-MM-DD, or blank to clear.')
			.addText((t) => t.setValue(this.values.start).onChange((v) => { this.values.start = v.trim(); }));

		new Setting(contentEl).setName('Due date')
			.addText((t) => t.setValue(this.values.due).onChange((v) => { this.values.due = v.trim(); }));

		new Setting(contentEl).setName('Status')
			.addDropdown((d) => {
				d.addOption('', '(unset)');
				for (const s of STATUS_CHOICES) d.addOption(s, s);
				d.setValue(this.values.status).onChange((v) => { this.values.status = v; });
			});

		const err = contentEl.createDiv({ cls: 'wgantt-modal-error' });

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
				err.textContent = '';
				const problems = [];
				if (this.values.start && !parseDate(this.values.start)) problems.push('Start date must be YYYY-MM-DD.');
				if (this.values.due && !parseDate(this.values.due)) problems.push('Due date must be YYYY-MM-DD.');
				const s = parseDate(this.values.start), d = parseDate(this.values.due);
				if (s && d && s > d) problems.push('Start is later than due.');
				if (!this.values.start && !this.values.due) problems.push('At least one date is needed, or the item leaves the chart.');
				if (problems.length) { err.textContent = problems.join(' '); return; }

				const changes = {};
				changes[this.item.startField] = this.values.start || null;
				changes[this.item.endField] = this.values.due || null;
				if (this.values.status) changes[this.item.statusField] = this.values.status;

				try {
					await applyFrontmatter(this.app, this.item.path, changes);
					new Notice('Updated ' + this.item.title);
					this.close();
					if (this.onDone) this.onDone();
				} catch (e) {
					err.textContent = String(e && e.message ? e.message : e);
				}
			}));
	}

	onClose() { this.contentEl.empty(); }
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
		if (this.scaleOverride) cfg.scale = this.scaleOverride;
		await buildChart(
			root, this.plugin, cfg, this.sourcePath,
			() => this.render(),
			(scale) => { this.scaleOverride = scale; this.render(); }
		);
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
		this.cfg.hideFinished = s.viewHideFinished;

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

		this.select(c, 'Group', [['', 'None'], ['status', 'Status'], ['folder', 'Folder'], ['company', 'Company'], ['type', 'Type']],
			this.cfg.group, async (v) => {
				this.cfg.group = v;
				this.plugin.settings.viewGroup = v;
				await this.plugin.saveSettings();
				this.refresh();
			});

		// Everything is shown by default - proposed, active and finished
		// together - so this is an opt-out rather than a filter to discover.
		const toggle = el('label', 'wgantt-control wgantt-control-check', c);
		const cb = el('input', null, toggle);
		cb.type = 'checkbox';
		cb.checked = this.cfg.hideFinished;
		el('span', 'wgantt-control-label', toggle, 'Hide finished');
		toggle.title = 'Hide notes whose status is completed or done';
		cb.addEventListener('change', async () => {
			this.cfg.hideFinished = cb.checked;
			this.plugin.settings.viewHideFinished = cb.checked;
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
		await buildChart(
			this.chartEl, this.plugin, this.cfg, null,
			() => this.refresh(),
			async (scale) => {
				this.cfg.scale = scale;
				this.plugin.settings.viewScale = scale;
				await this.plugin.saveSettings();
				this.buildControls();
				this.refresh();
			}
		);
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

		new Setting(containerEl).setName('Editing').setHeading();

		new Setting(containerEl)
			.setName('Allow editing')
			.setDesc('When on, the chart can create notes and change start_date, due_date, ' +
				'status, and completed_date. Turn it off to make the plugin read-only.')
			.addToggle((t) => t.setValue(this.plugin.settings.allowEditing)
				.onChange(async (v) => { this.plugin.settings.allowEditing = v; await save(); }));

		text('New project folder', 'Where "New project" puts new notes.', 'newProjectFolder', '03_Projects/Active');

		new Setting(containerEl).setName('About').setHeading();
		const about = containerEl.createDiv({ cls: 'wgantt-about' });
		about.createEl('p', {
			text: 'This plugin makes no network requests. It does write to your vault, but only ' +
				'to create a note you asked for, or to set start_date, due_date, status and ' +
				'completed_date on an existing one. Frontmatter edits go through Obsidian’s own ' +
				'processFrontMatter, so note bodies are never touched and nothing is deleted.',
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
			id: 'new-gantt-project',
			name: 'New project',
			callback: () => {
				if (!this.settings.allowEditing) {
					new Notice('Editing is turned off in the Gantt Calendar settings.');
					return;
				}
				new NewProjectModal(this.app, this, null).open();
			},
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
		const migrated = migrateSettings(stored);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
		// Persist the migration so it runs once, not on every load.
		if (!stored || stored.settingsVersion !== SETTINGS_VERSION) {
			await this.saveSettings();
		}
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
	shiftSpan, dragWrites, doneToggleWrites, safeFileName, newProjectContent,
	isFinished, zoomScale, SCALE_ORDER, FINISHED_STATUSES,
	migrateSettings, SETTINGS_VERSION,
	SCALES, STATUS_COLORS, STATUS_CHOICES, DEFAULT_SETTINGS,
	VIEW_TYPE_GANTT, RIBBON_ICON,
};
