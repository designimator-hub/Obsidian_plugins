/*
 * Test harness for Wright Gantt Calendar.
 *
 * No test framework, matching the no-dependency rule. Run it with:
 *   node test/run-tests.js
 *
 * It stubs the 'obsidian' module so main.js can be loaded outside the app,
 * then exercises the pure date and configuration logic.
 */

'use strict';

const path = require('path');
const Module = require('module');

/* Intercept require('obsidian') and hand back the stub. */
const stub = require('./obsidian-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === 'obsidian') return path.join(__dirname, 'obsidian-stub.js');
	return originalResolve.call(this, request, ...args);
};

const Plugin = require('../main.js');
const T = Plugin.__test;

/* ---------- tiny assertion helpers ---------- */

let passed = 0;
const failures = [];

function check(name, fn) {
	try {
		fn();
		passed++;
	} catch (e) {
		failures.push(`${name}\n    ${e.message}`);
	}
}

function eq(actual, expected, note) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${note || ''} expected ${b}, got ${a}`);
}

function ok(cond, note) {
	if (!cond) throw new Error(note || 'expected truthy');
}

const iso = (d) => (d ? T.isoDate(d) : null);

/* ---------- date parsing ---------- */

check('parseDate accepts YYYY-MM-DD strings', () => {
	eq(iso(T.parseDate('2026-07-31')), '2026-07-31');
	eq(iso(T.parseDate('  2026-01-01  ')), '2026-01-01');
});

check('parseDate accepts a datetime prefix', () => {
	eq(iso(T.parseDate('2026-03-15T09:30:00')), '2026-03-15');
});

check('parseDate rejects nonsense', () => {
	eq(T.parseDate(''), null);
	eq(T.parseDate(null), null);
	eq(T.parseDate(undefined), null);
	eq(T.parseDate('not a date'), null);
	eq(T.parseDate('31-07-2026'), null);
});

check('parseDate rejects impossible calendar dates', () => {
	// Date would silently roll 2026-02-31 over into March.
	eq(T.parseDate('2026-02-31'), null);
	eq(T.parseDate('2026-13-01'), null);
	eq(T.parseDate('2026-00-10'), null);
});

check('parseDate accepts leap days correctly', () => {
	eq(iso(T.parseDate('2024-02-29')), '2024-02-29'); // leap year
	eq(T.parseDate('2026-02-29'), null);              // not a leap year
});

check('parseDate reads Date objects as UTC, not local', () => {
	// Obsidian yields UTC midnight for a bare YAML date. Reading it with
	// local getters would shift the day backwards west of Greenwich.
	const utcMidnight = new Date(Date.UTC(2026, 6, 31));
	eq(iso(T.parseDate(utcMidnight)), '2026-07-31');
});

check('parseDate rejects invalid Date objects', () => {
	eq(T.parseDate(new Date('nope')), null);
});

/* ---------- date arithmetic ---------- */

check('daysBetween counts whole days', () => {
	eq(T.daysBetween(T.parseDate('2026-01-01'), T.parseDate('2026-01-31')), 30);
	eq(T.daysBetween(T.parseDate('2026-01-01'), T.parseDate('2026-01-01')), 0);
});

/*
 * A DST transition makes two local midnights differ by 23 or 25 hours rather
 * than 24, so a naive ms/86400000 lands on 30.958... or 31.041... instead of
 * a whole number.
 *
 * We cannot reach a real transition from a test: this machine runs on a zone
 * with no DST, and Node on Windows ignores the TZ environment variable, so
 * forcing a DST zone is not available either. Instead we construct the exact
 * arithmetic a transition produces, which is what daysBetween has to survive
 * and is independent of the ambient timezone.
 */
check('daysBetween rounds through a sub-day shortfall (spring forward)', () => {
	const a = T.parseDate('2026-03-01');
	const b = new Date(a.getTime() + 31 * 86400000 - 3600000); // 31 days less an hour
	eq(T.daysBetween(a, b), 31);
});

check('daysBetween rounds through a sub-day surplus (fall back)', () => {
	const a = T.parseDate('2026-10-15');
	const b = new Date(a.getTime() + 31 * 86400000 + 3600000); // 31 days plus an hour
	eq(T.daysBetween(a, b), 31);
});

check('daysBetween is exact on whole days in the ambient zone', () => {
	eq(T.daysBetween(T.parseDate('2026-03-01'), T.parseDate('2026-04-01')), 31);
	eq(T.daysBetween(T.parseDate('2026-10-15'), T.parseDate('2026-11-15')), 31);
});

check('addDays crosses month and year boundaries', () => {
	eq(iso(T.addDays(T.parseDate('2026-01-31'), 1)), '2026-02-01');
	eq(iso(T.addDays(T.parseDate('2026-12-31'), 1)), '2027-01-01');
	eq(iso(T.addDays(T.parseDate('2026-01-01'), -1)), '2025-12-31');
});

check('startOfWeek honours the configured first day', () => {
	// 2026-07-31 is a Friday.
	eq(iso(T.startOfWeek(T.parseDate('2026-07-31'), 1)), '2026-07-27'); // Monday
	eq(iso(T.startOfWeek(T.parseDate('2026-07-31'), 0)), '2026-07-26'); // Sunday
});

check('period starts land where expected', () => {
	const d = T.parseDate('2026-08-15');
	eq(iso(T.startOfMonth(d)), '2026-08-01');
	eq(iso(T.startOfQuarter(d)), '2026-07-01');
	eq(iso(T.startOfYear(d)), '2026-01-01');
});

/* ---------- axis ticks ---------- */

check('stepStarts produces one tick per day', () => {
	const t = T.stepStarts('day', T.parseDate('2026-01-01'), T.parseDate('2026-01-10'), 1);
	eq(t.length, 10);
	eq(iso(t[0]), '2026-01-01');
	eq(iso(t[9]), '2026-01-10');
});

check('stepStarts steps weeks from the week boundary', () => {
	const t = T.stepStarts('week', T.parseDate('2026-01-01'), T.parseDate('2026-01-31'), 1);
	ok(t.length >= 4 && t.length <= 6, `got ${t.length} week ticks`);
	for (const d of t) eq(d.getDay(), 1, 'each week tick should be a Monday:');
});

check('stepStarts steps months and years', () => {
	const m = T.stepStarts('month', T.parseDate('2026-01-15'), T.parseDate('2026-06-10'), 1);
	eq(m.map(iso), ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01']);

	const y = T.stepStarts('year', T.parseDate('2025-06-01'), T.parseDate('2027-02-01'), 1);
	eq(y.map(iso), ['2025-01-01', '2026-01-01', '2027-01-01']);
});

check('stepStarts cannot run away on a huge range', () => {
	const t = T.stepStarts('day', T.parseDate('1900-01-01'), T.parseDate('2100-01-01'), 1);
	ok(t.length <= 5000, 'guard should cap the loop');
});

check('tick labels read sensibly', () => {
	eq(T.tickLabel('day', T.parseDate('2026-07-31'), 1), '31');
	eq(T.tickLabel('month', T.parseDate('2026-07-31'), 1), 'Jul');
	eq(T.tickLabel('quarter', T.parseDate('2026-07-31'), 1), 'Q3');
	eq(T.majorLabel('month', T.parseDate('2026-07-31')), 'Jul 2026');
	eq(T.majorLabel('year', T.parseDate('2026-07-31')), '2026');
});

/* ---------- config parsing ---------- */

check('parseConfig reads a normal block', () => {
	const { cfg, errors } = T.parseConfig(
		'title: Project Timeline\nfolder: 03_Projects\nscale: week\nsort: start'
	);
	eq(errors, []);
	eq(cfg.title, 'Project Timeline');
	eq(cfg.folder, '03_Projects');
	eq(cfg.scale, 'week');
	eq(cfg.sort, 'start');
});

check('parseConfig ignores blanks and comments', () => {
	const { cfg, errors } = T.parseConfig('\n# a comment\n// another\n\nscale: day\n');
	eq(errors, []);
	eq(cfg.scale, 'day');
});

check('parseConfig splits and normalises lists', () => {
	const { cfg } = T.parseConfig('status: Active, Planned ,waiting\ntag: #project/design, knowledge');
	eq(cfg.status, ['active', 'planned', 'waiting']);
	eq(cfg.tags, ['project/design', 'knowledge']);
});

check('parseConfig strips surrounding slashes from folder', () => {
	const { cfg } = T.parseConfig('folder: /03_Projects/Active/');
	eq(cfg.folder, '03_Projects/Active');
});

check('parseConfig reports unknown options rather than ignoring them', () => {
	const { errors } = T.parseConfig('scail: week');
	eq(errors.length, 1);
	ok(errors[0].includes('unknown option'), errors[0]);
});

check('parseConfig rejects a bad scale and a bad date', () => {
	const a = T.parseConfig('scale: fortnight');
	eq(a.errors.length, 1);
	const b = T.parseConfig('from: 31-07-2026');
	eq(b.errors.length, 1);
});

check('parseConfig catches a reversed window', () => {
	const { errors } = T.parseConfig('from: 2026-12-01\nto: 2026-01-01');
	eq(errors.length, 1);
	ok(errors[0].includes('later than'), errors[0]);
});

check('parseConfig flags a line with no colon', () => {
	const { errors } = T.parseConfig('scale week');
	eq(errors.length, 1);
});

check('parseConfig handles booleans and limits', () => {
	const { cfg } = T.parseConfig('reverse: true\nshow-today: no\nlimit: 25');
	eq(cfg.reverse, true);
	eq(cfg.showToday, false);
	eq(cfg.limit, 25);
});

check('parseConfig rejects a negative limit', () => {
	const { errors } = T.parseConfig('limit: -3');
	eq(errors.length, 1);
});

/* ---------- spans ---------- */

check('normaliseSpans builds a span from two dates', () => {
	const items = T.normaliseSpans([
		{ start: T.parseDate('2026-09-03'), end: T.parseDate('2026-12-19'), done: null },
	]);
	eq(iso(items[0].spanStart), '2026-09-03');
	eq(iso(items[0].spanEnd), '2026-12-19');
	eq(items[0].milestone, false);
});

check('normaliseSpans treats a single date as a milestone', () => {
	const a = T.normaliseSpans([{ start: T.parseDate('2026-09-03'), end: null, done: null }]);
	eq(a[0].milestone, true);
	eq(iso(a[0].spanStart), '2026-09-03');

	const b = T.normaliseSpans([{ start: null, end: T.parseDate('2026-09-03'), done: null }]);
	eq(b[0].milestone, true);
});

check('normaliseSpans falls back to the completion date', () => {
	const items = T.normaliseSpans([
		{ start: T.parseDate('2026-01-01'), end: null, done: T.parseDate('2026-02-01') },
	]);
	eq(iso(items[0].spanEnd), '2026-02-01');
	eq(items[0].milestone, false);
});

check('normaliseSpans repairs reversed dates instead of drawing backwards', () => {
	const items = T.normaliseSpans([
		{ start: T.parseDate('2026-12-01'), end: T.parseDate('2026-01-01'), done: null },
	]);
	eq(iso(items[0].spanStart), '2026-01-01');
	eq(iso(items[0].spanEnd), '2026-12-01');
	eq(items[0].reversed, true);
});

check('same start and end is a milestone, not a zero-width bar', () => {
	const items = T.normaliseSpans([
		{ start: T.parseDate('2026-05-05'), end: T.parseDate('2026-05-05'), done: null },
	]);
	eq(items[0].milestone, true);
});

/* ---------- sorting ---------- */

check('sortItems orders by start, then title', () => {
	const mk = (title, s) => ({ title, start: T.parseDate(s), end: null, done: null, status: '' });
	const items = T.normaliseSpans([mk('Zebra', '2026-03-01'), mk('Alpha', '2026-01-01'), mk('Beta', '2026-01-01')]);
	T.sortItems(items, { sort: 'start', reverse: false });
	eq(items.map((i) => i.title), ['Alpha', 'Beta', 'Zebra']);
});

check('sortItems reverses on request', () => {
	const mk = (title, s) => ({ title, start: T.parseDate(s), end: null, done: null, status: '' });
	const items = T.normaliseSpans([mk('A', '2026-01-01'), mk('B', '2026-06-01')]);
	T.sortItems(items, { sort: 'start', reverse: true });
	eq(items.map((i) => i.title), ['B', 'A']);
});

check('sortItems can order by title', () => {
	const mk = (title, s) => ({ title, start: T.parseDate(s), end: null, done: null, status: '' });
	const items = T.normaliseSpans([mk('Charlie', '2026-01-01'), mk('alpha', '2026-06-01')]);
	T.sortItems(items, { sort: 'title', reverse: false });
	eq(items.map((i) => i.title), ['alpha', 'Charlie']);
});

/* ---------- tags ---------- */

check('matchesTag matches nested children', () => {
	ok(T.matchesTag(['project/design'], ['project']), 'parent should match child');
	ok(T.matchesTag(['project/design', 'work'], ['project', 'work']), 'all wanted tags required');
});

check('matchesTag does not match a prefix that is not a tag boundary', () => {
	ok(!T.matchesTag(['projection'], ['project']), '"projection" must not match "project"');
});

check('matchesTag requires every wanted tag', () => {
	ok(!T.matchesTag(['project'], ['project', 'urgent']));
});

/* ---------- plugin surface ---------- */

/*
 * Async checks are collected and awaited before the report, so a rejected
 * promise fails the run instead of being swallowed.
 */
const pending = [];
function checkAsync(name, fn) {
	pending.push(
		Promise.resolve()
			.then(fn)
			.then(() => { passed++; })
			.catch((e) => { failures.push(`${name}\n    ${e.message}`); })
	);
}

checkAsync('loadSettings merges stored values over the defaults', async () => {
	const p = new Plugin({}, {});
	p._data = { defaultScale: 'month', labelWidth: 300 };
	await p.loadSettings();
	eq(p.settings.defaultScale, 'month', 'stored value should win:');
	eq(p.settings.labelWidth, 300, 'stored value should win:');
	eq(p.settings.startField, T.DEFAULT_SETTINGS.startField, 'unset key should fall back:');
	eq(p.settings.weekStart, T.DEFAULT_SETTINGS.weekStart, 'unset key should fall back:');
});

checkAsync('loadSettings works on a first run with no stored data', async () => {
	const p = new Plugin({}, {});
	p._data = null;
	await p.loadSettings();
	eq(p.settings, T.DEFAULT_SETTINGS);
});

checkAsync('saveSettings round-trips', async () => {
	const p = new Plugin({}, {});
	p._data = null;
	await p.loadSettings();
	p.settings.rowHeight = 44;
	await p.saveSettings();
	eq(p._data.rowHeight, 44);
});

check('every status colour resolves to a theme variable', () => {
	for (const [status, value] of Object.entries(T.STATUS_COLORS)) {
		ok(/^var\(--/.test(value), `${status} should use a CSS variable, got ${value}`);
	}
});

check('every scale defines a positive pixels-per-day', () => {
	for (const [name, def] of Object.entries(T.SCALES)) {
		ok(def.pxPerDay > 0, `${name} needs a positive pxPerDay`);
		ok(def.minor && def.major, `${name} needs minor and major tick kinds`);
	}
});

/* ---------- scoping ---------- */

const fakeFile = (path) => ({
	path,
	basename: path.split('/').pop().replace(/\.md$/, ''),
	parent: { path: path.split('/').slice(0, -1).join('/') || '/' },
});

check('inScope with no filter accepts everything', () => {
	const cfg = T.defaultConfig();
	ok(T.inScope(fakeFile('anywhere/note.md'), cfg, null));
});

check('inScope folder matches the folder and its children', () => {
	const cfg = T.defaultConfig();
	cfg.folder = '03_Projects';
	ok(T.inScope(fakeFile('03_Projects/Active/JARVIS.md'), cfg, null));
	ok(!T.inScope(fakeFile('04_Knowledge/Note.md'), cfg, null));
});

check('inScope folder does not match a partial name', () => {
	const cfg = T.defaultConfig();
	cfg.folder = '03_Proj';
	ok(!T.inScope(fakeFile('03_Projects/Active/JARVIS.md'), cfg, null),
		'"03_Proj" must not match "03_Projects"');
});

check('inScope file matches by path or basename', () => {
	const cfg = T.defaultConfig();
	cfg.file = 'Gantt Test';
	ok(T.inScope(fakeFile('Gantt Test.md'), cfg, null));
	ok(!T.inScope(fakeFile('Other.md'), cfg, null));

	const cfg2 = T.defaultConfig();
	cfg2.file = '03_Projects/Active/JARVIS.md';
	ok(T.inScope(fakeFile('03_Projects/Active/JARVIS.md'), cfg2, null));
});

check('inScope "file: this" resolves to the containing note', () => {
	const cfg = T.defaultConfig();
	cfg.file = 'this';
	ok(T.inScope(fakeFile('Gantt Test.md'), cfg, 'Gantt Test.md'));
	ok(!T.inScope(fakeFile('Elsewhere.md'), cfg, 'Gantt Test.md'));
});

check('inScope "file: this" outside a note matches nothing', () => {
	const cfg = T.defaultConfig();
	cfg.file = 'this';
	ok(!T.inScope(fakeFile('Anything.md'), cfg, null), 'the view has no source path');
});

check('parseConfig accepts the file option', () => {
	const { cfg, errors } = T.parseConfig('file: this\nsource: tasks');
	eq(errors, []);
	eq(cfg.file, 'this');
	eq(cfg.source, 'tasks');
});

/* ---------- plugin registration ---------- */

checkAsync('onload registers the view, ribbon icon, and commands', async () => {
	const p = new Plugin({}, {});
	p._data = null;
	await p.onload();
	eq(p.registered.codeBlocks, ['gantt']);
	eq(p.registered.views, [T.VIEW_TYPE_GANTT]);
	eq(p.registered.ribbons.length, 1, 'expected exactly one ribbon icon:');
	eq(p.registered.ribbons[0].icon, T.RIBBON_ICON);
	ok(p.registered.commands.includes('open-gantt-view'), 'open command missing');
	ok(p.registered.commands.includes('insert-gantt-block'), 'insert command missing');
});

/* ---------- drag arithmetic ---------- */

const span = (a, b) => ({ start: T.parseDate(a), end: T.parseDate(b) });

check('shiftSpan move shifts both ends by the same amount', () => {
	const r = T.shiftSpan('move', T.parseDate('2026-09-01'), T.parseDate('2026-09-10'), 5);
	eq(iso(r.start), '2026-09-06');
	eq(iso(r.end), '2026-09-15');
});

check('shiftSpan move works backwards', () => {
	const r = T.shiftSpan('move', T.parseDate('2026-09-01'), T.parseDate('2026-09-10'), -3);
	eq(iso(r.start), '2026-08-29');
	eq(iso(r.end), '2026-09-07');
});

check('shiftSpan start moves only the left edge', () => {
	const r = T.shiftSpan('start', T.parseDate('2026-09-01'), T.parseDate('2026-09-10'), 4);
	eq(iso(r.start), '2026-09-05');
	eq(iso(r.end), '2026-09-10');
});

check('shiftSpan start cannot be dragged past the end', () => {
	const r = T.shiftSpan('start', T.parseDate('2026-09-01'), T.parseDate('2026-09-10'), 60);
	eq(iso(r.start), '2026-09-10', 'clamped to the end date:');
	eq(iso(r.end), '2026-09-10');
});

check('shiftSpan end cannot be dragged before the start', () => {
	const r = T.shiftSpan('end', T.parseDate('2026-09-01'), T.parseDate('2026-09-10'), -60);
	eq(iso(r.start), '2026-09-01');
	eq(iso(r.end), '2026-09-01', 'clamped to the start date:');
});

check('shiftSpan does not mutate its inputs', () => {
	const a = T.parseDate('2026-09-01');
	const b = T.parseDate('2026-09-10');
	T.shiftSpan('move', a, b, 30);
	eq(iso(a), '2026-09-01', 'input start was mutated:');
	eq(iso(b), '2026-09-10', 'input end was mutated:');
});

check('shiftSpan crosses month and year boundaries', () => {
	const r = T.shiftSpan('move', T.parseDate('2026-12-28'), T.parseDate('2026-12-31'), 5);
	eq(iso(r.start), '2027-01-02');
	eq(iso(r.end), '2027-01-05');
});

/* ---------- what a drag writes ---------- */

const item = (over) => Object.assign({
	hasStart: true, hasEnd: true,
	startField: 'start_date', endField: 'due_date',
	doneField: 'completed_date', statusField: 'status',
	status: 'active',
}, over || {});

check('dragging a two-date bar writes both fields', () => {
	const w = T.dragWrites(item(), 'move', span('2026-09-06', '2026-09-15'));
	eq(w, { start_date: '2026-09-06', due_date: '2026-09-15' });
});

check('dragging a due-only milestone does not invent a start date', () => {
	const w = T.dragWrites(item({ hasStart: false }), 'move', span('2026-09-06', '2026-09-15'));
	eq(w, { due_date: '2026-09-15' }, 'start_date must not appear:');
});

check('dragging a start-only milestone does not invent a due date', () => {
	const w = T.dragWrites(item({ hasEnd: false }), 'move', span('2026-09-06', '2026-09-15'));
	eq(w, { start_date: '2026-09-06' }, 'due_date must not appear:');
});

check('resizing writes only the edge that moved', () => {
	eq(T.dragWrites(item(), 'start', span('2026-09-05', '2026-09-10')), { start_date: '2026-09-05' });
	eq(T.dragWrites(item(), 'end', span('2026-09-01', '2026-09-20')), { due_date: '2026-09-20' });
});

check('dragWrites honours custom field names', () => {
	const w = T.dragWrites(item({ startField: 'begins', endField: 'ends' }), 'move', span('2026-01-01', '2026-01-05'));
	eq(w, { begins: '2026-01-01', ends: '2026-01-05' });
});

/* ---------- done toggle ---------- */

check('done toggle on an open item completes it and stamps today', () => {
	const r = T.doneToggleWrites(item({ status: 'active' }), '2026-07-31');
	eq(r.nowDone, true);
	eq(r.changes, { status: 'completed', completed_date: '2026-07-31' });
});

check('done toggle on a completed item reopens it and clears the date', () => {
	const r = T.doneToggleWrites(item({ status: 'completed' }), '2026-07-31');
	eq(r.nowDone, false);
	eq(r.changes.status, 'active');
	eq(r.changes.completed_date, null, 'null means delete the key:');
});

check('done toggle is reversible', () => {
	const open = item({ status: 'active' });
	const first = T.doneToggleWrites(open, '2026-07-31');
	const closed = item({ status: first.changes.status });
	const second = T.doneToggleWrites(closed, '2026-07-31');
	eq(second.changes.status, 'active', 'toggling twice returns to active:');
});

/* ---------- new note creation ---------- */

check('safeFileName strips characters Obsidian rejects', () => {
	eq(T.safeFileName('JARVIS: 3F/ICU *fit-out*?'), 'JARVIS- 3F-ICU -fit-out--');
	eq(T.safeFileName('  spaced   out  '), 'spaced out');
});

check('safeFileName refuses to produce a dotfile', () => {
	eq(T.safeFileName('...hidden'), 'hidden');
});

check('safeFileName caps the length', () => {
	ok(T.safeFileName('x'.repeat(400)).length <= 120);
});

check('newProjectContent produces parseable frontmatter', () => {
	const md = T.newProjectContent({
		title: 'Test Project', type: 'project', status: 'active',
		start: '2026-09-01', due: '2026-12-01', todayIso: '2026-07-31',
		owner: 'James Wright', company: 'Anicom',
	});
	ok(md.startsWith('---\n'), 'must open with frontmatter');
	const end = md.indexOf('\n---\n', 4);
	ok(end > 0, 'frontmatter must close');
	const fm = md.slice(4, end);
	ok(/^start_date: 2026-09-01$/m.test(fm), 'start_date missing');
	ok(/^due_date: 2026-12-01$/m.test(fm), 'due_date missing');
	ok(/^status: active$/m.test(fm), 'status missing');
	ok(/^owner: James Wright$/m.test(fm), 'owner missing');
	ok(md.includes('# Test Project'), 'body heading missing');
});

check('newProjectContent omits optional keys when unset', () => {
	const md = T.newProjectContent({ title: 'Bare', todayIso: '2026-07-31' });
	const fm = md.slice(4, md.indexOf('\n---\n', 4));
	ok(!/^owner:/m.test(fm), 'owner should be absent');
	ok(!/^company:/m.test(fm), 'company should be absent');
	ok(/^start_date:\s*$/m.test(fm), 'start_date should be present but blank');
});

/* ---------- settings migration ---------- */

check('migration widens the old Active-only view folder', () => {
	const out = T.migrateSettings({ viewFolder: '03_Projects/Active' });
	eq(out.viewFolder, '03_Projects', 'the old default hid every proposed project:');
	eq(out.settingsVersion, T.SETTINGS_VERSION);
});

check('migration leaves a deliberately chosen folder alone', () => {
	eq(T.migrateSettings({ viewFolder: '05_Faith' }).viewFolder, '05_Faith');
	eq(T.migrateSettings({ viewFolder: '' }).viewFolder, '');
	eq(T.migrateSettings({ viewFolder: '03_Projects/Proposed' }).viewFolder, '03_Projects/Proposed');
});

check('migration does not re-run once stamped', () => {
	const once = T.migrateSettings({ viewFolder: '03_Projects/Active' });
	// A user who deliberately picks Active afterwards must keep it.
	once.viewFolder = '03_Projects/Active';
	eq(T.migrateSettings(once).viewFolder, '03_Projects/Active');
});

check('migration copes with no stored settings at all', () => {
	eq(T.migrateSettings(null).settingsVersion, T.SETTINGS_VERSION);
	eq(T.migrateSettings(undefined).settingsVersion, T.SETTINGS_VERSION);
	eq(T.migrateSettings({}).settingsVersion, T.SETTINGS_VERSION);
});

check('migration does not mutate the stored object', () => {
	const stored = { viewFolder: '03_Projects/Active' };
	T.migrateSettings(stored);
	eq(stored.viewFolder, '03_Projects/Active', 'input was mutated:');
	eq(stored.settingsVersion, undefined);
});

checkAsync('loadSettings applies the migration and persists it', async () => {
	const p = new Plugin({}, {});
	p._data = { viewFolder: '03_Projects/Active', viewScale: 'month' };
	await p.loadSettings();
	eq(p.settings.viewFolder, '03_Projects');
	eq(p.settings.viewScale, 'month', 'unrelated settings must survive:');
	eq(p._data.settingsVersion, T.SETTINGS_VERSION, 'migration should be saved back:');
});

/* ---------- finished filter and zoom ---------- */

check('isFinished recognises the finished statuses only', () => {
	ok(T.isFinished('completed'));
	ok(T.isFinished('done'));
	ok(T.isFinished('Completed'), 'should be case-insensitive');
	ok(!T.isFinished('active'));
	ok(!T.isFinished('proposed'));
	ok(!T.isFinished('cancelled'), 'cancelled is not finished, it is abandoned');
	ok(!T.isFinished('review'), 'review is work in progress');
	ok(!T.isFinished(''));
	ok(!T.isFinished(null));
});

check('isFinished accepts the word the toggle actually uses', () => {
	// The control says "Hide finished", so a note marked Finished has to
	// count. Leaving this out made the toggle lie about what it does.
	ok(T.isFinished('finished'));
	ok(T.isFinished('Finished'), 'as typed by hand in a note');
	ok(T.isFinished('FINISHED'));
});

check('every finished status is offered in the editing dropdown', () => {
	for (const st of T.FINISHED_STATUSES) {
		if (st === 'done') continue; // synonym of completed, not offered twice
		ok(T.STATUS_CHOICES.includes(st), `${st} is missing from STATUS_CHOICES`);
	}
});

check('the done toggle understands every finished spelling', () => {
	for (const st of ['completed', 'done', 'finished', 'Finished']) {
		const r = T.doneToggleWrites({
			status: st, statusField: 'status', doneField: 'completed_date',
		}, '2026-07-31');
		eq(r.nowDone, false, `${st} should be treated as already done:`);
		eq(r.changes.status, 'active');
	}
});

check('statuses in use have a distinct colour rather than the accent default', () => {
	for (const st of ['review', 'finished', 'proposed', 'active']) {
		ok(T.STATUS_COLORS[st], `${st} has no colour mapping`);
	}
	eq(T.STATUS_COLORS.finished, T.STATUS_COLORS.completed, 'finished should read as completed:');
});

check('hide-finished is off by default so everything shows together', () => {
	eq(T.defaultConfig().hideFinished, false);
	eq(T.DEFAULT_SETTINGS.viewHideFinished, false);
});

check('hide-finished option is parsed', () => {
	eq(T.parseConfig('hide-finished: true').cfg.hideFinished, true);
	eq(T.parseConfig('hide-finished: no').cfg.hideFinished, false);
	eq(T.parseConfig('hide-finished: yes').errors, []);
});

check('the default view folder covers all project states', () => {
	// 03_Projects/Active would hide Proposed and Completed, which is the
	// opposite of showing everything on one chart.
	eq(T.DEFAULT_SETTINGS.viewFolder, '03_Projects');
});

check('zoomScale steps through the scales in order', () => {
	eq(T.zoomScale('month', 'in'), 'week');
	eq(T.zoomScale('week', 'in'), 'day');
	eq(T.zoomScale('week', 'out'), 'month');
	eq(T.zoomScale('month', 'out'), 'quarter');
});

check('zoomScale stops at both ends rather than wrapping', () => {
	eq(T.zoomScale('day', 'in'), 'day');
	eq(T.zoomScale('quarter', 'out'), 'quarter');
});

check('zoomScale leaves an unknown scale alone', () => {
	eq(T.zoomScale('fortnight', 'in'), 'fortnight');
});

check('every zoom step is a real scale', () => {
	for (const name of T.SCALE_ORDER) ok(T.SCALES[name], `${name} is not a defined scale`);
	eq(T.SCALE_ORDER.length, Object.keys(T.SCALES).length, 'zoom order must cover every scale:');
});

check('readonly option is parsed', () => {
	eq(T.parseConfig('readonly: true').cfg.readonly, true);
	eq(T.parseConfig('readonly: false').cfg.readonly, false);
	eq(T.defaultConfig().readonly, false);
});

check('every editable status choice has a colour or falls back cleanly', () => {
	for (const s of T.STATUS_CHOICES) {
		ok(typeof s === 'string' && s.length > 0);
	}
	ok(T.STATUS_CHOICES.includes('completed'), 'done toggle depends on "completed"');
	ok(T.STATUS_CHOICES.includes('active'), 'reopen depends on "active"');
});

/* ---------- source hygiene ---------- */

check('source contains no network or dynamic-execution calls', () => {
	const fs = require('fs');
	const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
	// Drop the header comment, which names these terms on purpose.
	const body = src.slice(src.indexOf('*/') + 2);
	const banned = [
		/\bfetch\s*\(/, /\brequestUrl\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/,
		/\beval\s*\(/, /\bnew Function\s*\(/, /\bchild_process\b/, /\bimportScripts\b/,
	];
	for (const re of banned) {
		ok(!re.test(body), `banned construct found: ${re}`);
	}
});

check('source never assigns innerHTML', () => {
	const fs = require('fs');
	const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
	const body = src.slice(src.indexOf('*/') + 2);
	ok(!/\.innerHTML\s*=/.test(body), 'innerHTML assignment found');
	ok(!/\.outerHTML\s*=/.test(body), 'outerHTML assignment found');
});

check('manifest and package metadata agree', () => {
	const fs = require('fs');
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
	const versions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'versions.json'), 'utf8'));
	ok(manifest.id && manifest.name && manifest.version, 'manifest needs id, name, version');
	ok(versions[manifest.version], `versions.json missing an entry for ${manifest.version}`);
	eq(versions[manifest.version], manifest.minAppVersion);
});

/* ---------- report ---------- */

Promise.all(pending).then(() => {
	console.log('');
	if (failures.length === 0) {
		console.log(`  All ${passed} checks passed.`);
		console.log('');
		process.exit(0);
	} else {
		console.log(`  ${passed} passed, ${failures.length} FAILED\n`);
		for (const f of failures) console.log('  x ' + f + '\n');
		process.exit(1);
	}
});
