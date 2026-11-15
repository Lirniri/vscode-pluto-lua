// Entry point of the Pluto extension for VS Code.
//
// Syntax highlighting is purely declarative (see Pluto.tmbundle); this file adds the language
// features that need code: a workspace index with completion, hover, signature help,
// go-to-definition, outline, folding, and automatic insertion of `end`.

"use strict";

const vscode = require("vscode");
const { WorkspaceIndex } = require("./workspaceIndex");
const { Analyzer } = require("./analysis");
const { createProviders, lineContext, SHOW_DECLARATIONS_COMMAND, PEEK_CODE_COMMAND } = require("./providers");
const { WorkspaceFilter } = require("./workspaceFilter");
const { registerDiagnostics } = require("./diagnostics");
const { registerTypeAutoTrigger, registerNullableHighlight } = require("./typeEditor");
const { buildRules, mergeRules, findProblems, CATEGORIES } = require("./highlightColors");
const { t, resolveLanguage, setLanguage } = require("./i18n");

const PLUTO_SELECTOR = [{ language: "pluto" }];
// `.lua` files are matched by language and by extension, as they are plain text without a Lua extension.
const LUA_SELECTOR = [{ language: "lua" }, { pattern: "**/*.lua" }];

/**
 * Document selector the language providers are registered for.
 * @param {boolean} luaEnabled `pluto.lua.enable`
 */
function selectorFor(luaEnabled)
{
	return luaEnabled ? [...PLUTO_SELECTOR, ...LUA_SELECTOR] : PLUTO_SELECTOR;
}
const MAX_FILE_SIZE = 2 * 1024 * 1024;

class LanguageService
{
	constructor()
	{
		this.index = new WorkspaceIndex();
		this.analyzer = new Analyzer(this.index);
		this.filter = new WorkspaceFilter();
		/** Document versions the index is in sync with, by URI. */
		this._versions = new Map();
		this._timers = new Map();
		this._scanId = 0;
		this._decoder = new TextDecoder("utf-8");
		/** Number of files skipped by the last scan because of ignore files / exclude settings. */
		this.excludedCount = 0;
	}

	/**
	 * The up-to-date index record of an open document. Also makes it the file that lookups are
	 * made from, so an excluded file still sees its own declarations.
	 * @param {vscode.TextDocument} document
	 */
	getRecord(document)
	{
		const key = document.uri.toString();
		// A `.lua` file that is not to be indexed still works on its own, like an excluded file.
		const excluded = this.filter.isExcluded(document.uri) || (this._isLua(document.uri) && !this._luaIndexed());
		let record = this.index.getFile(key);
		// Records read from disk lack the call list the Outline needs, so re-parse them once opened.
		if (!record || this._versions.get(key) !== document.version || record.excluded !== excluded || !record.calls)
		{
			this._versions.set(key, document.version);
			record = this.index.setFile(key, document.uri.fsPath, document.getText(), excluded, { calls: true });
		}
		this.index.setCurrent(record);
		return record;
	}

	_isLua(uri)
	{
		return /\.lua$/i.test(uri.path);
	}

	/** Whether the language features (providers, diagnostics) are on for `.lua` files: `pluto.lua.enable`. */
	luaEnabled()
	{
		return vscode.workspace.getConfiguration("pluto").get("lua.enable", true) !== false;
	}

	/** Whether `.lua` files are read into the index: `pluto.lua.indexFiles` (and the older `pluto.index.includeLua`). */
	_luaIndexed()
	{
		const config = vscode.workspace.getConfiguration("pluto");
		return config.get("lua.indexFiles", true) !== false && config.get("index.includeLua", true) !== false;
	}

	/**
	 * Whether the language features apply to a document: Pluto files, and Lua files if enabled.
	 * @param {vscode.TextDocument} document
	 */
	handles(document)
	{
		return document.languageId == "pluto" || /\.pluto$/i.test(document.uri.path) || (this._isLua(document.uri) && this.luaEnabled());
	}

	/** Whether a file is read from disk into the index. */
	_isSource(uri)
	{
		return /\.pluto$/i.test(uri.path) || (this._isLua(uri) && this._luaIndexed());
	}

	_openDocument(uri)
	{
		const key = uri.toString();
		return vscode.workspace.textDocuments.find(d => d.uri.toString() == key);
	}

	/**
	 * (Re)indexes a file from disk, unless it is open in an editor — then the editor's content wins.
	 * @param {vscode.Uri} uri
	 */
	async indexUri(uri, forceDisk)
	{
		const isManifest = /(^|\/)info\.json$/i.test(uri.path);
		if (!isManifest && !this._isSource(uri))
		{
			return;
		}
		const open = forceDisk ? undefined : this._openDocument(uri);
		if (open && !isManifest)
		{
			this.getRecord(open);
			return;
		}
		if (this.filter.isExcluded(uri))
		{
			this.removeUri(uri);
			return;
		}
		try
		{
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_FILE_SIZE)
			{
				return;
			}
			const text = this._decoder.decode(await vscode.workspace.fs.readFile(uri));
			if (isManifest)
			{
				this.index.setManifest(uri.toString(), uri.fsPath, text);
			}
			else
			{
				this._versions.delete(uri.toString());
				this.index.setFile(uri.toString(), uri.fsPath, text);
			}
		}
		catch (e)
		{
			this.removeUri(uri);
		}
	}

	removeUri(uri)
	{
		const key = uri.toString();
		this._versions.delete(key);
		this.index.removeFile(key);
		this.index.removeManifest(key);
	}

	/**
	 * Scans all workspace folders for Pluto/Lua files and module manifests.
	 * @param {{ incremental?: boolean }} [options] With `incremental`, the existing index is kept:
	 *   files that are now excluded are dropped and files that are not indexed yet are added.
	 */
	async scan(options)
	{
		const incremental = !!(options && options.incremental);
		const scanId = ++this._scanId;
		const config = vscode.workspace.getConfiguration("pluto");
		await this.filter.reload();
		if (scanId != this._scanId)
		{
			return;
		}
		if (incremental)
		{
			for (const key of [...this.index.files.keys(), ...this.index.manifests.keys()])
			{
				const uri = vscode.Uri.parse(key, true);
				if (this.filter.isExcluded(uri))
				{
					this.removeUri(uri);
				}
			}
		}
		else
		{
			this.index.clear();
			this._versions.clear();
		}
		this.excludedCount = 0;
		if (config.get("index.enabled", true) && vscode.workspace.workspaceFolders)
		{
			const maxFiles = Math.max(1, config.get("index.maxFiles", 5000));
			const exclude = this.filter.findFilesExclude();
			const pattern = this._luaIndexed() ?"**/*.{pluto,lua}" : "**/*.pluto";
			const [sources, manifests] = await Promise.all([
				vscode.workspace.findFiles(pattern, exclude, maxFiles),
				vscode.workspace.findFiles("**/info.json", exclude, 1000),
			]);
			const all = [...sources, ...manifests].filter((uri) =>
			{
				if (this.filter.isExcluded(uri))
				{
					++this.excludedCount;
					return false;
				}
				const key = uri.toString();
				return !incremental || !(this.index.files.has(key) || this.index.manifests.has(key));
			});
			// Read in small batches so we neither block nor open thousands of files at once.
			for (let i = 0; i < all.length; i += 32)
			{
				if (scanId != this._scanId)
				{
					return; // superseded by a newer scan
				}
				await Promise.all(all.slice(i, i + 32).map(uri => this.indexUri(uri)));
			}
		}
		// Open documents are always indexed, even outside of the workspace or when indexing is off.
		for (const document of vscode.workspace.textDocuments)
		{
			if (this.handles(document) || this._isSource(document.uri))
			{
				this.getRecord(document);
			}
		}
	}

	/**
	 * Debounced re-parse of a document that is being edited.
	 * @param {vscode.TextDocument} document
	 */
	scheduleUpdate(document)
	{
		const key = document.uri.toString();
		clearTimeout(this._timers.get(key));
		this._timers.set(key, setTimeout(() =>
		{
			this._timers.delete(key);
			if (!document.isClosed)
			{
				this.getRecord(document);
			}
		}, 250));
	}

	dispose()
	{
		for (const timer of this._timers.values())
		{
			clearTimeout(timer);
		}
		this._timers.clear();
	}
}

// Lines after which pressing Enter should produce a matching `end` (or `until`).
const BLOCK_OPENER = /^\s*(?:(?:local|export|static|public|private|protected)\s+)*(?:(?:function\b.*\)\s*(?::\s*[^=]+)?)|(?:(?:if|elseif)\b.*\b(?:then|do))|(?:(?:for|while|switch|pluto_switch)\b.*\bdo)|(?:do)|(?:(?:class|pluto_class)\s+[\w.]+(?:\s+extends\s+[\w.]+)?)|(?:(?:enum|pluto_enum)\b.*\bbegin)|(?:try|pluto_try)|(?:repeat))\s*$/;
const ASSIGNED_OPENER = /(?:=|\(|,|\breturn)\s*(?:function\s*\([^)]*\)\s*(?::\s*[^=]+)?|class(?:\s+extends\s+[\w.]+)?)\s*$|->\s*do\s*$|\bthen\s*$|\bdo\s*$/;

/**
 * Removes a trailing line comment, taking strings into account.
 */
function stripComment(line)
{
	let quote = null;
	for (let i = 0; i < line.length; ++i)
	{
		const c = line[i];
		if (quote)
		{
			if (c == "\\")
			{
				++i;
			}
			else if (c == quote)
			{
				quote = null;
			}
		}
		else if (c == "\"" || c == "'")
		{
			quote = c;
		}
		else if (c == "-" && line[i + 1] == "-")
		{
			return line.slice(0, i);
		}
	}
	return line;
}

/**
 * Decides what should be inserted below the cursor after Enter was pressed at the end of `line`.
 * @param {string} line The line that was just completed.
 * @returns {"end"|"until "|null}
 */
function closerFor(line)
{
	const code = stripComment(line).replace(/\s+$/, "");
	if (!code || lineContext(code).kind != "code")
	{
		return null;
	}
	if (/^\s*repeat$/.test(code))
	{
		return "until ";
	}
	if (/\bend$/.test(code))
	{
		return null; // one-liner: `if x then return end`
	}
	if (/^\s*(?:else|elseif|case|default|catch|pluto_catch)\b/.test(code) || /^\s*\$/.test(code))
	{
		return null; // continues an existing block / preprocessor directive
	}
	return BLOCK_OPENER.test(code) || ASSIGNED_OPENER.test(code) ? "end" : null;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {LanguageService} service
 */
function registerAutoClose(context, service)
{
	let busy = false;
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (busy || document.languageId != "pluto" || event.contentChanges.length != 1)
		{
			return;
		}
		if (event.reason == vscode.TextDocumentChangeReason.Undo || event.reason == vscode.TextDocumentChangeReason.Redo)
		{
			return;
		}
		const change = event.contentChanges[0];
		// A plain Enter: a newline plus the indentation VS Code added, replacing nothing.
		if (change.rangeLength != 0 || !/^\r?\n[ \t]*$/.test(change.text))
		{
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== document || editor.selections.length != 1)
		{
			return;
		}
		if (!vscode.workspace.getConfiguration("pluto", document.uri).get("autoCloseBlocks", true))
		{
			return;
		}
		const openerLine = change.range.start.line;
		const openerText = document.lineAt(openerLine).text;
		// Enter must have been pressed at the end of the line.
		if (change.range.start.character < openerText.replace(/\s+$/, "").length)
		{
			return;
		}
		const closer = closerFor(openerText);
		if (!closer || openerLine + 1 >= document.lineCount)
		{
			return;
		}
		const newLine = document.lineAt(openerLine + 1);
		if (newLine.text.trim() != "")
		{
			return;
		}
		// Only add a closer if the document is actually missing one.
		const record = service.getRecord(document);
		if (closer == "end" ? record.unclosed == 0 : !hasUnclosedRepeat(record, openerLine))
		{
			return;
		}
		const indent = /^\s*/.exec(openerText)[0];
		const eol = document.eol == vscode.EndOfLine.CRLF ? "\r\n" : "\n";
		const insertAt = newLine.range.end;
		// The body of the block is indented one level deeper than its opener. VS Code normally does that
		// on Enter; when it did not (auto-indent off or overridden), do it here so no Tab is needed.
		const tab = tabSizeOf(editor);
		const body = indent + indentUnit(editor);
		const tooShallow = indentWidth(newLine.text, tab) <= indentWidth(indent, tab);
		const hasNextLine = openerLine + 2 < document.lineCount;
		busy = true;
		editor.edit(function (builder)
		{
			if (hasNextLine)
			{
				// The closer goes in front of the line below, not at the cursor: an edit at the cursor
				// moves it off the new line, and VS Code then wipes the indentation it just put there
				// (editor.trimAutoWhitespace).
				builder.insert(new vscode.Position(openerLine + 2, 0), indent + closer + eol);
				if (tooShallow)
				{
					builder.replace(newLine.range, body);
				}
			}
			else if (tooShallow)
			{
				builder.replace(newLine.range, body + eol + indent + closer);
			}
			else
			{
				builder.insert(insertAt, eol + indent + closer);
			}
		}, { undoStopBefore: false, undoStopAfter: false }).then(function ()
		{
			// Keep the cursor on the indented empty line between opener and closer.
			const line = document.lineAt(openerLine + 1);
			if (line.text.trim() == "" && indentWidth(line.text, tab) < indentWidth(body, tab))
			{
				// The indentation was wiped anyway (the cursor had to move): put it back.
				return editor.edit(function (builder)
				{
					builder.replace(line.range, body);
				}, { undoStopBefore: false, undoStopAfter: false }).then(function () { return true; });
			}
			return true;
		}).then(function ()
		{
			const pos = new vscode.Position(openerLine + 1, document.lineAt(openerLine + 1).text.length);
			editor.selection = new vscode.Selection(pos, pos);
			busy = false;
		}, function ()
		{
			busy = false;
		});
	}));
}

function tabSizeOf(editor)
{
	return Number(editor.options.tabSize) || 4;
}

/** One level of indentation as the editor is set up: a tab, or `tabSize` spaces. */
function indentUnit(editor)
{
	return editor.options.insertSpaces === false ? "\t" : " ".repeat(tabSizeOf(editor));
}

/** Width of leading whitespace, a tab counting as `tab` columns. */
function indentWidth(text, tab)
{
	let width = 0;
	for (const c of text)
	{
		if (c == " ")
		{
			++width;
		}
		else if (c == "\t")
		{
			width += tab;
		}
		else
		{
			break;
		}
	}
	return width;
}

function hasUnclosedRepeat(record, line)
{
	// A `repeat` without `until` is closed by the parser at the end of the file.
	return record.blocks.some(b => b.kind == "repeat" && b.startLine == line && b.endLine >= record.lineCount - 1) && record.unclosed > 0;
}

function registerCommands(context, service)
{
	const runInTerminalTask = function (name, command, extraArgs)
	{
		const editor = vscode.window.activeTextEditor;
		if (!editor)
		{
			vscode.window.showWarningMessage(t("cmd.openScript"));
			return;
		}
		vscode.tasks.executeTask(new vscode.Task(
			{ type: "shell" },
			vscode.TaskScope.Workspace,
			name,
			"pluto-syntax-highlighting",
			new vscode.ShellExecution(command, [...extraArgs, editor.document.fileName])
		));
	};
	context.subscriptions.push(vscode.commands.registerCommand("pluto-syntax-highlighting.run", function ()
	{
		runInTerminalTask(t("task.run"), "pluto", []);
	}));
	context.subscriptions.push(vscode.commands.registerCommand("pluto-syntax-highlighting.lint", function ()
	{
		runInTerminalTask(t("task.lint"), "plutoc", ["-p"]);
	}));
	context.subscriptions.push(vscode.commands.registerCommand("pluto-syntax-highlighting.reindex", async function ()
	{
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t("status.indexing") }, () => service.scan());
		vscode.window.setStatusBarMessage(t("status.indexed", service.index.files.size, service.index.manifests.size)
			+ (service.excludedCount ? t("status.excluded", service.excludedCount) : ""), 5000);
	}));
}

let reportedColorProblems = "";

/** Tells about wrong values in the color settings, once for each distinct set of mistakes. */
function reportColorProblems(problems)
{
	const key = JSON.stringify(problems);
	if (key == reportedColorProblems)
	{
		return;
	}
	reportedColorProblems = key;
	if (!problems.length)
	{
		return;
	}
	const lines = problems.map(p => p.problem == "unknownKey"
		? t("colors.problem.unknownKey", p.name, p.value, Object.keys(CATEGORIES).join(", "))
		: t("colors.problem." + p.problem, "pluto.highlight." + p.name, p.value));
	vscode.window.showWarningMessage(lines.join("\n"), t("colors.openSettings")).then(function (choice)
	{
		if (choice)
		{
			vscode.commands.executeCommand("workbench.action.openSettingsJson");
		}
	});
}

/**
 * Keeps the colors set in `pluto.highlight.colors` / `pluto.highlight.tableBracketColors` in
 * `editor.tokenColorCustomizations`, as rules named "Pluto: ..." next to the user's own rules.
 * With `pluto.highlight.applyColors` off they are removed again.
 */
async function applyHighlightColors()
{
	const config = vscode.workspace.getConfiguration("pluto");
	const enabled = config.get("highlight.applyColors", false) === true;
	// Light themes (and high contrast light) use `lightColor`, the others `darkColor`.
	const themeKind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
	const kind = themeKind === vscode.ColorThemeKind.Light || themeKind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
	const rules = enabled
		? buildRules(config.get("highlight.colors"), config.get("highlight.tableBracketColors"), kind)
		: [];
	// A wrong value is never applied (the color of the theme stays); the user is told about it.
	reportColorProblems(enabled ? findProblems(config.get("highlight.colors"), config.get("highlight.tableBracketColors")) : []);
	const editorConfig = vscode.workspace.getConfiguration();
	const inspected = editorConfig.inspect("editor.tokenColorCustomizations");
	const current = (inspected && inspected.globalValue) || {};
	const merged = mergeRules(current.textMateRules, rules);
	if (JSON.stringify(merged) == JSON.stringify(Array.isArray(current.textMateRules) ? current.textMateRules : []))
	{
		return;
	}
	const next = Object.assign({}, current);
	if (merged.length)
	{
		next.textMateRules = merged;
	}
	else
	{
		delete next.textMateRules;
	}
	await editorConfig.update("editor.tokenColorCustomizations", Object.keys(next).length ? next : undefined, vscode.ConfigurationTarget.Global);
}

/**
 * Registers the document-bound language providers for Pluto, and for Lua while `pluto.lua.enable`
 * is on. `refresh()` re-registers them after the setting changed.
 * @param {vscode.ExtensionContext} context
 * @param {LanguageService} service
 * @param {ReturnType<typeof createProviders>} providers
 */
function registerLanguageProviders(context, service, providers)
{
	let registered = [];
	const dispose = function ()
	{
		for (const d of registered)
		{
			d.dispose();
		}
		registered = [];
	};
	const controller = {
		/** The selector in use, `null` before the first registration. */
		selector: null,
		refresh()
		{
			const selector = selectorFor(service.luaEnabled());
			if (controller.selector && JSON.stringify(controller.selector) == JSON.stringify(selector))
			{
				return;
			}
			dispose();
			controller.selector = selector;
			registered = [
				vscode.languages.registerCompletionItemProvider(selector, providers.completionProvider, ".", ":", "\"", "'", " "),
				vscode.languages.registerHoverProvider(selector, providers.hoverProvider),
				vscode.languages.registerSignatureHelpProvider(selector, providers.signatureProvider, "(", ","),
				vscode.languages.registerDefinitionProvider(selector, providers.definitionProvider),
				vscode.languages.registerDocumentSymbolProvider(selector, providers.documentSymbolProvider, { label: "Pluto" }),
				vscode.languages.registerFoldingRangeProvider(selector, providers.foldingProvider),
			];
		},
		dispose,
	};
	controller.refresh();
	context.subscriptions.push({ dispose });
	return controller;
}

/**
 * Sets the language of the messages: `pluto.language` (`auto` follows the editor's display language,
 * `vscode.env.language`; Russian for `ru`/`ru-RU`, English otherwise).
 * @returns {"en"|"ru"}
 */
function applyLanguage()
{
	const setting = vscode.workspace.getConfiguration("pluto").get("language", "auto");
	const language = resolveLanguage(setting, vscode.env && vscode.env.language);
	setLanguage(language);
	return language;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context)
{
	applyLanguage();
	const service = new LanguageService();
	context.subscriptions.push(service);
	registerCommands(context, service);

	const providers = createProviders(service);
	const languageProviders = registerLanguageProviders(context, service, providers);
	context.subscriptions.push(
		vscode.commands.registerCommand(SHOW_DECLARATIONS_COMMAND, providers.showDeclarations),
		vscode.commands.registerCommand(PEEK_CODE_COMMAND, providers.peekCode),
		vscode.languages.registerWorkspaceSymbolProvider(providers.workspaceSymbolProvider)
	);
	registerAutoClose(context, service);
	registerTypeAutoTrigger(context);
	registerNullableHighlight(context);
	applyHighlightColors().catch(() => { });
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event)
	{
		if (event.affectsConfiguration("pluto.highlight"))
		{
			applyHighlightColors().catch(() => { });
		}
	}));
	if (vscode.window.onDidChangeActiveColorTheme)
	{
		// The color of a rule depends on whether the theme is dark or light.
		context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => applyHighlightColors().catch(() => { })));
	}

	// Keep the index in sync with editors and the file system.
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(function (event)
		{
			if (event.contentChanges.length && (service.handles(event.document) || service._isSource(event.document.uri)))
			{
				service.scheduleUpdate(event.document);
			}
		}),
		vscode.workspace.onDidOpenTextDocument(function (document)
		{
			if (service.handles(document))
			{
				service.getRecord(document);
			}
		}),
		vscode.workspace.onDidSaveTextDocument(function (document)
		{
			service.indexUri(document.uri);
		}),
		vscode.workspace.onDidCloseTextDocument(function (document)
		{
			// Unsaved changes are gone now; fall back to what is on disk (or drop untitled documents).
			if (document.uri.scheme == "file")
			{
				service.indexUri(document.uri, true);
			}
			else
			{
				service.removeUri(document.uri);
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(function ()
		{
			watchIgnoreFiles();
			service.scan();
		}),
		vscode.workspace.onDidChangeConfiguration(function (event)
		{
			if (event.affectsConfiguration("pluto.language"))
			{
				applyLanguage(); // hovers and diagnostics are built from the dictionary on demand
			}
			if (event.affectsConfiguration("pluto.lua"))
			{
				// Takes effect at once: providers are re-registered, the index rebuilt (diagnostics follow on their own).
				languageProviders.refresh();
				service.scan();
			}
			else if (event.affectsConfiguration("pluto.index"))
			{
				service.scan();
			}
			else if (event.affectsConfiguration("pluto.workspace") || event.affectsConfiguration("search.exclude") || event.affectsConfiguration("files.exclude"))
			{
				if (event.affectsConfiguration("pluto.workspace"))
				{
					watchIgnoreFiles();
				}
				refreshSoon();
			}
		}),
		{ dispose: () => disposeIgnoreWatchers() }
	);

	// Re-apply the exclusion rules when an ignore file is created, edited or deleted.
	let refreshTimer = null;
	function refreshSoon()
	{
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(function ()
		{
			service.scan({ incremental: true }).catch(e => console.error("Pluto: failed to update the workspace index", e));
		}, 300);
	}
	let ignoreWatchers = [];
	function disposeIgnoreWatchers()
	{
		clearTimeout(refreshTimer);
		for (const d of ignoreWatchers)
		{
			d.dispose();
		}
		ignoreWatchers = [];
	}
	function watchIgnoreFiles()
	{
		disposeIgnoreWatchers();
		for (const pattern of service.filter.watchPatterns())
		{
			const w = vscode.workspace.createFileSystemWatcher(pattern);
			ignoreWatchers.push(w, w.onDidCreate(refreshSoon), w.onDidChange(refreshSoon), w.onDidDelete(refreshSoon));
		}
	}
	watchIgnoreFiles();

	const watcher = vscode.workspace.createFileSystemWatcher("**/{*.pluto,*.lua,info.json}");
	const inIndexScope = function (uri)
	{
		return vscode.workspace.getConfiguration("pluto").get("index.enabled", true);
	};
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(uri => inIndexScope(uri) && service.indexUri(uri)),
		watcher.onDidChange(uri => inIndexScope(uri) && service.indexUri(uri)),
		watcher.onDidDelete(uri => service.removeUri(uri))
	);

	const indexed = service.scan().catch(function (e)
	{
		console.error("Pluto: failed to index workspace", e);
	});
	vscode.window.setStatusBarMessage("$(sync~spin) " + t("status.indexing"), indexed);

	const diagnostics = registerDiagnostics(context, service, indexed);

	return { service, diagnostics };
}

function deactivate() {}

module.exports = { activate, deactivate, LanguageService, closerFor, registerLanguageProviders, selectorFor, applyLanguage };
