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
