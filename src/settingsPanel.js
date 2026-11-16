// The settings panel: a window with a tab for each group of settings, real switches, choices and color pickers,
// that reads and writes the same settings of VS Code. See ./settingsModel for the tabs and what may be saved.

"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { t, getLanguage } = require("./i18n");
const { buildModel, validateChange, TABS } = require("./settingsModel");

/** Strings of the panel itself (not of the settings), in the language in use. */
function panelStrings()
{
	const keys = ["title", "search", "reset", "openJson", "add", "remove", "clear", "isDefault", "changed", "saved", "invalid", "style", "color", "dark", "light", "nothing", "colorsHead", "oneLine", "compilerPath"];
	const out = {};
	for (const k of keys)
	{
		out[k] = t("settings." + k);
	}
	return out;
}

function tabTitles()
{
	const out = {};
	for (const tab of TABS)
	{
		out[tab.id] = t("settings.tab." + tab.id);
	}
	return out;
}

/** The texts of package.nls.json (with the Russian ones over them when Russian is in use). */
function loadNls(extensionPath)
{
	const read = (name) =>
	{
		try
		{
			return JSON.parse(fs.readFileSync(path.join(extensionPath, name), "utf8"));
		}
		catch (e)
		{
			return {};
		}
	};
	const base = read("package.nls.json");
	return getLanguage() == "ru" ? Object.assign({}, base, read("package.nls.ru.json")) : base;
}

/** The data of the page as base64: no character of it can end the element it sits in. */
function embed(value)
{
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** The script of the page (./settingsClient.js), read once. */
let clientScript = null;
function client()
{
	if (clientScript === null)
	{
		clientScript = fs.readFileSync(path.join(__dirname, "settingsClient.js"), "utf8");
	}
	return clientScript;
}

/**
 * The page of the panel.
 * @param {object} model
 * @param {Record<string, string>} strings
 * @param {string} nonce
 * @param {string} cspSource
 */
function renderHtml(model, strings, nonce, cspSource)
{
	return `<!DOCTYPE html>
<html lang="${getLanguage()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pluto</title>
<style nonce="${nonce}">
	:root { color-scheme: light dark; }
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0 24px 48px; }
	header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 16px 0 0; z-index: 2; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884)); }
	h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 12px; }
	.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
	#search { flex: 1; min-width: 180px; }
	#tabs { display: flex; gap: 2px; overflow-x: auto; }
	.tab { background: transparent; color: var(--vscode-foreground); border: 0; border-bottom: 2px solid transparent; padding: 8px 12px; cursor: pointer; opacity: .75; white-space: nowrap; font: inherit; }
	.tab:hover { opacity: 1; }
	.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #0078d4); font-weight: 600; }
	.badge { margin-left: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 9px; padding: 0 6px; font-size: .85em; }
	#body { max-width: 900px; padding-top: 8px; }
	.item { padding: 14px 0 14px 14px; border-left: 3px solid transparent; margin: 2px 0; }
	.item.modified { border-left-color: var(--vscode-settings-modifiedItemIndicator, #1b81a8); }
	.head { display: flex; align-items: baseline; gap: 10px; }
	h3 { font-size: 1em; margin: 0; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
	.status { font-size: .85em; opacity: .85; flex: 1; }
	.status.ok { color: var(--vscode-testing-iconPassed, #388a34); }
	.status.err { color: var(--vscode-errorForeground, #f14c4c); }
	.link { margin-left: auto; background: none; border: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; padding: 0; }
	.desc p { margin: 4px 0; opacity: .85; line-height: 1.45; }
	code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
	.control { margin-top: 6px; }
	input[type=text], input[type=number], select, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #8886); padding: 4px 6px; font: inherit; border-radius: 2px; }
	input:focus, select:focus, textarea:focus, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	input[type=checkbox] { width: 16px; height: 16px; }
	.wide { width: 100%; box-sizing: border-box; }
	.colorfield { display: inline-flex; align-items: center; gap: 4px; }
	input[type=color] { width: 28px; height: 24px; padding: 0; border: 1px solid var(--vscode-input-border, #8886); background: none; cursor: pointer; }
	input[type=color].empty { opacity: .35; }
	.hex { width: 92px; font-family: var(--vscode-editor-font-family, monospace); }
	.bad { outline: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c); }
	button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 4px 10px; cursor: pointer; font: inherit; border-radius: 2px; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button.icon { padding: 0 6px; background: none; color: var(--vscode-foreground); opacity: .6; }
	button.icon:hover { opacity: 1; }
	.stylerow { display: grid; grid-template-columns: 1fr; gap: 4px; padding: 8px 0; border-top: 1px solid var(--vscode-widget-border, #8883); }
	.stylecells { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
	.stylecells label, .map label { display: inline-flex; gap: 6px; align-items: center; }
	.map { display: flex; gap: 14px; flex-wrap: wrap; }
	.muted { opacity: .6; }
</style>
</head>
<body>
<header>
	<h1 id="title"></h1>
	<div class="bar"><input id="search" type="text" aria-label="search"><button id="openJson"></button></div>
	<div id="tabs" role="tablist"></div>
</header>
<main id="body"></main>
<script type="application/json" id="data">${embed({ model, strings })}</script>
<script nonce="${nonce}">${client()}</script>
</body>
</html>`;
}

/** The manifest of this extension, read from the disk (VS Code's own copy has its texts translated already). */
function loadManifest(extensionPath)
{
	return JSON.parse(fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"));
}

let panel = null;

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ command?: boolean }} [options] `command: false` only builds the handler, without registering the command (tests).
 */
function registerSettingsPanel(context, options)
{
	const pkg = loadManifest(context.extensionPath);
	const props = pkg.contributes.configuration.properties;
	const valueOf = (key) => vscode.workspace.getConfiguration().get(key);
	let own = 0; // our own saves are not echoed back to the panel

	/** Saves what the panel asks for, after checking it. @returns {Promise<object>} the answer for the panel. */
	const handle = async function (message)
	{
		if (!message || typeof message != "object")
		{
			return null;
		}
		if (message.type == "openJson")
		{
			vscode.commands.executeCommand("workbench.action.openSettingsJson");
			return null;
		}
		if (message.type == "reset" && typeof message.key == "string" && Object.prototype.hasOwnProperty.call(props, message.key) && message.key.startsWith("plua."))
		{
			await vscode.workspace.getConfiguration().update(message.key, undefined, vscode.ConfigurationTarget.Global);
			return { type: "saved", key: message.key, ok: true, value: valueOf(message.key) };
		}
		if (message.type == "set" && typeof message.key == "string")
		{
			const checked = validateChange(pkg, message.key, message.value);
			if (!checked.ok)
			{
				return { type: "saved", key: message.key, ok: false, error: checked.error, value: valueOf(message.key) };
			}
			own = Date.now();
			// A value that is the default is removed from settings.json instead of being written there.
			await vscode.workspace.getConfiguration().update(message.key, checked.isDefault ? undefined : checked.value, vscode.ConfigurationTarget.Global);
			return { type: "saved", key: message.key, ok: true, value: valueOf(message.key) };
		}
		return null;
	};

	const show = function ()
	{
		if (panel)
		{
			panel.reveal();
			return;
		}
		panel = vscode.window.createWebviewPanel("plutoSettings", t("settings.title"), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		const nonce = Array.from({ length: 24 }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
		const model = buildModel(pkg, loadNls(context.extensionPath), valueOf, tabTitles());
		panel.webview.html = renderHtml(model, panelStrings(), nonce, panel.webview.cspSource);
		panel.webview.onDidReceiveMessage(async (message) =>
		{
			const answer = await handle(message);
			if (answer && panel)
			{
				panel.webview.postMessage(answer);
			}
		});
		panel.onDidDispose(() => { panel = null; });
	};

	if (options && options.command === false)
	{
		return { handle, show };
	}
	context.subscriptions.push(
		vscode.commands.registerCommand("plua.openSettings", show),
		vscode.workspace.onDidChangeConfiguration(function (event)
		{
			// Edited in settings.json or the standard editor: the panel follows.
			if (!panel || !event.affectsConfiguration("plua") || Date.now() - own < 400)
			{
				return;
			}
			const values = {};
			for (const key of Object.keys(props))
			{
				values[key] = valueOf(key);
			}
			panel.webview.postMessage({ type: "values", values });
		}),
		{ dispose() { if (panel) { panel.dispose(); } } }
	);
	return { handle, show };
}

module.exports = { registerSettingsPanel, renderHtml, panelStrings, tabTitles, loadNls, embed };
