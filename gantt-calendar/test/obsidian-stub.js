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

class Plugin extends Component {
	constructor(app, manifest) {
		super();
		this.app = app;
		this.manifest = manifest;
		this._data = null;
	}
	async loadData() { return this._data; }
	async saveData(d) { this._data = d; }
	registerMarkdownCodeBlockProcessor() {}
	addSettingTab() {}
	addCommand() {}
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
	Plugin, PluginSettingTab, Setting, MarkdownRenderChild,
	MarkdownView, Component,
	Notice: class Notice {},
	TFile: class TFile {},
};
