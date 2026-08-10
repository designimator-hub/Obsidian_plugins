/*
 * Minimal stand-in for Obsidian's API so that main.js can be required
 * outside the app. Only the pieces main.js touches at load time exist here.
 * This file is for tests; it never ships to a vault.
 */

class Component {
	registerEvent() {}
	register() {}
}

class MarkdownRenderChild extends Component {
	constructor(containerEl) {
		super();
		this.containerEl = containerEl;
	}
}

class ItemView extends Component {
	constructor(leaf) {
		super();
		this.leaf = leaf;
		this.contentEl = null;
	}
}

class Modal {
	constructor(app) {
		this.app = app;
		this.contentEl = null;
	}
	open() { this.opened = true; }
	close() { this.opened = false; }
}

class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this._data = null;
		this.registered = { views: [], ribbons: [], commands: [], codeBlocks: [] };
	}
	async loadData() { return this._data; }
	async saveData(d) { this._data = d; }
	registerMarkdownCodeBlockProcessor(lang, fn) { this.registered.codeBlocks.push(lang); }
	registerView(type, fn) { this.registered.views.push(type); }
	addRibbonIcon(icon, title, fn) { this.registered.ribbons.push({ icon, title }); return {}; }
	addSettingTab() {}
	addCommand(c) { this.registered.commands.push(c.id); }
}

class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
	}
}

class Setting {
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText() { return this; }
	addToggle() { return this; }
	addDropdown() { return this; }
}

class MarkdownView {}

module.exports = {
	Plugin, PluginSettingTab, Setting, MarkdownRenderChild, ItemView, Modal,
	MarkdownView, Component,
	Notice: class Notice {},
	TFile: class TFile {},
};
