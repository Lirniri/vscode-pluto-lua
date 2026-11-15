// Live diagnostics: problems reported by an external Pluto compiler (if one is found) plus the
// built-in static checks of ./lint, shown as squiggles and in the Problems panel.

"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { lintSource, lintManifest } = require("./lint");
const { lintJsonPaths, extensionOf } = require("./jsonPaths");
const { GlobSet } = require("./ignore");
const compiler = require("./compiler");
const { t } = require("./i18n");

const MANIFEST = /(^|\/)info\.json$/i;

class DiagnosticsManager
{
	/**
	 * @param {import("./extension").LanguageService} service
	 */
	constructor(service)
	{
		this.service = service;
		this.collection = vscode.languages.createDiagnosticCollection("pluto");
		this.output = null;
		/** Per document: compiler problems and lint problems, merged into the collection. */
		this._compiler = new Map();
		this._lint = new Map();
		this._timers = new Map();
		this._runs = new Map();
		this._runIds = new Map();
		/** @type {{ path: string|null, source: string|null }|null} */
		this._compiler_ = null;
		/** @type {{ path: string|null, source: string|null }|null} The Lua interpreter that checks `.lua` files. */
		this._luaCompiler_ = null;
		this._relintTimer = null;
		/** Every file of the workspace folders (not ignored), for the paths in JSON files; null until read. */
		this._allFiles = null;
		this._allFilesLoading = false;
		this._noFolderShown = false;
		/** Suggestions of the "file not found" problems, by document and position, for the quick fix. */
		this.jsonSuggestions = new Map();
	}

	_config()
	{
		const config = vscode.workspace.getConfiguration("pluto");
		return {
			enabled: config.get("diagnostics.enable", true),
			luaEnabled: config.get("lua.enable", true) !== false,
			compilerPath: config.get("diagnostics.compilerPath", "") || "",
			debounceMs: Math.max(0, Number(config.get("diagnostics.debounceMs", 400)) || 0),
			indexEnabled: config.get("index.enabled", true),
			// `.lua` files are syntax-checked with a Lua interpreter while the Lua support is on.
			luaCheck: config.get("lua.enable", true) !== false && config.get("lua.checkSyntax", true) !== false,
			luaCompilerPath: config.get("lua.compilerPath", "") || "",
			duplicates: ["warning", "error", "off"].includes(config.get("diagnostics.duplicateParams", "warning")) ? config.get("diagnostics.duplicateParams", "warning") : "warning",
			brackets: ["off", "suggest", "auto"].includes(config.get("format.fixMismatchedBrackets", "suggest")) ? config.get("format.fixMismatchedBrackets", "suggest") : "suggest",
			returnTypes: ["warning", "error", "off"].includes(config.get("diagnostics.returnTypes", "warning")) ? config.get("diagnostics.returnTypes", "warning") : "warning",
			caseFallthrough: config.get("diagnostics.caseFallthrough", "off") == "hint" ? "hint" : "off",
			jsonEnabled: config.get("json.enable", true) !== false,
			jsonFiles: config.get("json.files", ["**/info.json"]),
			jsonExtensions: config.get("json.extensions", [".pluto", ".lua"]),
			jsonCheckAll: config.get("json.checkAllPaths", false) === true,
			jsonSeverity: config.get("json.severity", "warning"),
			jsonNotify: config.get("json.notifyNoFolder", true) !== false,
		};
	}

	_log(message)
	{
		if (!this.output && vscode.window.createOutputChannel)
		{
			this.output = vscode.window.createOutputChannel("Pluto");
		}
		if (this.output)
		{
			this.output.appendLine("[" + new Date().toLocaleTimeString() + "] " + message);
		}
	}

	_trusted()
	{
		return vscode.workspace.isTrusted !== false;
	}

	/**
	 * The compiler to use, found once and cached until settings or workspace folders change.
	 * Running a program from the workspace is only allowed in trusted workspaces.
	 */
	compiler()
	{
		if (!this._compiler_)
		{
			if (!this._trusted())
			{
				this._compiler_ = { path: null, source: null };
				this._log(t("diag.untrusted"));
				return this._compiler_;
			}
			const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme == "file").map(f => f.uri.fsPath);
			const found = compiler.findCompiler({ configured: this._config().compilerPath, workspaceFolders: folders });
			if (found.problem)
			{
				this._log(found.problem);
			}
			this._log(found.path
				? t("diag.using", found.path, t("diag.source." + found.source))
				: t("diag.none"));
			this._compiler_ = found;
		}
		return this._compiler_;
	}

	/**
	 * The Lua interpreter that checks `.lua` files (only while `pluto.lua.enable` is on): `pluto.lua.compilerPath`,
	 * else `bin/lua`, `tools/lua`... of the workspace, else `luac` / `lua` / `luajit` on the PATH.
	 */
	luaCompiler()
	{
		if (!this._luaCompiler_)
		{
			if (!this._trusted())
			{
				this._luaCompiler_ = { path: null, source: null };
				this._log(t("diag.untrusted"));
				return this._luaCompiler_;
			}
			const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme == "file").map(f => f.uri.fsPath);
			const found = compiler.findCompiler({ configured: this._config().luaCompilerPath, workspaceFolders: folders, family: "lua" });
			if (found.problem)
			{
				this._log(found.problem.replace("pluto.diagnostics.compilerPath", "pluto.lua.compilerPath"));
			}
			this._log(found.path
				? t("diag.luaUsing", found.path, t("diag.source." + found.source).replace("pluto.diagnostics.compilerPath", "pluto.lua.compilerPath"))
				: t("diag.luaNone"));
			this._luaCompiler_ = found;
		}
		return this._luaCompiler_;
	}

	/** Forgets the detected compilers, e.g. after a setting changed. */
	resetCompiler()
	{
		this._compiler_ = null;
		this._luaCompiler_ = null;
	}

	_isPluto(document)
	{
		return document.languageId == "pluto" || /\.pluto$/i.test(document.uri.path);
	}

	_isLua(document)
	{
		return document.languageId == "lua" || /.lua$/i.test(document.uri.path);
	}

	/** Whether this extension checks the document at all (`.lua` files only while `pluto.lua.enable` is on). */
	_isChecked(document, config)
	{
		if (this._isPluto(document) || this._isManifest(document) || this._isJsonPaths(document, config))
		{
			return true;
		}
		return this._isLua(document) && config.luaEnabled;
	}

	_isManifest(document)
	{
		return MANIFEST.test(document.uri.path);
	}

	/**
	 * Whether the paths in a JSON document are checked: `pluto.json.files` (default `**\/info.json`).
	 * The patterns are matched against the path inside of the workspace folder, or the whole path outside of one.
	 */
	_isJsonPaths(document, config)
	{
		if (!config.jsonEnabled || !/\.jsonc?$/i.test(document.uri.path) || document.uri.scheme != "file")
		{
			return false;
		}
		const globs = new GlobSet(Array.isArray(config.jsonFiles) ? config.jsonFiles : []);
		if (globs.empty)
		{
			return false;
		}
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		const full = document.uri.path.replace(/^\//, "");
		if (folder)
		{
			const base = folder.uri.path.replace(/\/+$/, "");
			if (globs.matches(document.uri.path.slice(base.length + 1)))
			{
				return true;
			}
		}
		return globs.matches(full);
	}

	/** Whether a document is checked in any way: Pluto, Lua, manifests and the JSON files with paths. */
	_isRelevant(document)
	{
		return this._isPluto(document) || this._isManifest(document) || this._isLua(document)
			|| (/\.jsonc?$/i.test(document.uri.path) && this._isJsonPaths(document, this._config()));
	}

	/**
	 * Re-checks a document after the configured delay.
	 * @param {vscode.TextDocument} document
	 */
	schedule(document, immediate)
	{
		if (!this._isRelevant(document))
		{
			return;
		}
		const key = document.uri.toString();
		clearTimeout(this._timers.get(key));
		const config = this._config();
		if (!config.enabled || !this._isChecked(document, config))
		{
			this.clear(document.uri);
			return;
		}
		this._timers.set(key, setTimeout(() =>
		{
			this._timers.delete(key);
			if (!document.isClosed)
			{
				this.check(document);
			}
		}, immediate ? 0 : config.debounceMs));
	}

	/**
	 * Runs all checks on a document now.
	 * @param {vscode.TextDocument} document
	 * @returns {Promise<void>} Resolves when the compiler (if any) has finished.
	 */
	check(document)
	{
		const config = this._config();
		if (!config.enabled || !this._isChecked(document, config))
		{
			this.clear(document.uri);
			return Promise.resolve();
		}
		const key = document.uri.toString();
		if (this._isManifest(document) || this._isJsonPaths(document, config))
		{
			this._lint.set(key, this._lintJson(document, config));
			this._publish(document.uri);
			return Promise.resolve();
		}
		if (!this._isPluto(document) && !this._isLua(document))
		{
			return Promise.resolve();
		}
		try
		{
			this._lint.set(key, this._lintSource(document, config));
		}
		catch (e)
		{
			console.error("Pluto: lint failed", e);
			this._lint.set(key, []);
		}
		if (!this._isPluto(document))
		{
			this._publish(document.uri);
			if (config.luaCheck)
			{
				// Not the Pluto compiler (Lua may use names that are keywords in Pluto): a Lua interpreter.
				return this._runCompiler(document);
			}
			this._compiler.delete(key);
			this._publish(document.uri);
			return Promise.resolve();
		}
		this._publish(document.uri);
		return this._runCompiler(document);
	}

	_exists(p)
	{
		try
		{
			return fs.statSync(p).isFile();
		}
		catch (e)
		{
			return false;
		}
	}

	_lintSource(document, config)
	{
		const record = this.service.getRecord(document);
		const local = document.uri.scheme == "file";
		const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme == "file").map(f => f.uri.fsPath.replace(/\\/g, "/"));
		const problems = lintSource(document.getText(), record, this.service.analyzer, {
			exists: local ? (p) => this._exists(p) : undefined,
			searchDirs: folders,
			// Without an index, other files are unknown, so a missing module can't be told apart.
			requires: config.indexEnabled || local,
			duplicates: config.duplicates,
			brackets: config.brackets,
			returnTypes: config.returnTypes,
			caseFallthrough: config.caseFallthrough,
		});
		return problems.map(p => this._toDiagnostic(p, "pluto-lint"));
	}

	/** The files of the workspace for the paths in JSON files: Pluto and Lua files, or all files with `checkAllPaths`. */
	_knownFiles(config)
	{
		if (config.jsonCheckAll)
		{
			if (this._allFiles)
			{
				return this._allFiles;
			}
			this._loadAllFiles();
		}
		return [...this.service.index.files.values()].map(f => f.path.replace(/\\/g, "/"));
	}

	/** Reads the names of all files of the workspace folders once, without the ignored ones. */
	_loadAllFiles()
	{
		if (this._allFilesLoading || !vscode.workspace.workspaceFolders)
		{
			return;
		}
		this._allFilesLoading = true;
		const max = Math.max(1, Number(vscode.workspace.getConfiguration("pluto").get("index.maxFiles", 5000)) || 5000);
		const filter = this.service.filter;
		Promise.resolve(vscode.workspace.findFiles("**/*", filter.findFilesExclude(), max * 4))
			.then((uris) =>
			{
				this._allFiles = uris.filter(u => u.scheme == "file" && !filter.isExcluded(u)).map(u => u.fsPath.replace(/\\/g, "/"));
				this.recheckSoon();
			})
			.catch(() => { this._allFiles = []; })
			.then(() => { this._allFilesLoading = false; });
	}

	/** Forgets the list of all files, e.g. after a file was created or deleted. */
	invalidateFiles()
	{
		if (this._allFiles !== null)
		{
			this._allFiles = null;
			this.recheckSoon();
		}
	}

	/** Tells once that without a folder only the neighbourhood of the JSON file is searched. */
	_notifyNoFolder(config)
	{
		if (this._noFolderShown || !config.jsonNotify || !vscode.window.showInformationMessage)
		{
			return;
		}
		this._noFolderShown = true;
		const open = t("json.openFolder");
		const more = t("json.moreInfo");
		const never = t("json.dontShow");
		Promise.resolve(vscode.window.showInformationMessage(t("json.noFolder"), open, more, never)).then(function (choice)
		{
			if (choice == open)
			{
				vscode.commands.executeCommand("workbench.action.files.openFolder");
			}
			else if (choice == more)
			{
				vscode.env.openExternal(vscode.Uri.parse("https://github.com/Lirniri/vscode-pluto-lua#json-path-checks"));
			}
			else if (choice == never)
			{
				vscode.workspace.getConfiguration("pluto").update("json.notifyNoFolder", false, vscode.ConfigurationTarget.Global);
			}
		}, () => {});
	}

	/** Problems of a JSON document: module manifest checks (`info.json`) and the paths of files in it. */
	_lintJson(document, config)
	{
		const key = document.uri.toString();
		let problems = [];
		const local = document.uri.scheme == "file";
		if (this._isManifest(document))
		{
			problems = this._lintManifest(document, config, true);
		}
		this.jsonSuggestions.delete(key);
		if (this._isJsonPaths(document, config))
		{
			const roots = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme == "file").map(f => f.uri.fsPath.replace(/\\/g, "/"));
			const inFolder = !!vscode.workspace.getWorkspaceFolder(document.uri);
			if (!inFolder)
			{
				this._notifyNoFolder(config);
			}
			const known = this._knownFiles(config);
			const extensions = new Set((Array.isArray(config.jsonExtensions) ? config.jsonExtensions : [".pluto", ".lua"])
				.filter(e => typeof e == "string" && e.trim())
				.map(e => (e.trim().startsWith(".") ? e.trim() : "." + e.trim()).toLowerCase()));
			if (config.jsonCheckAll)
			{
				for (const file of known)
				{
					const ext = extensionOf(file);
					if (ext)
					{
						extensions.add(ext);
					}
				}
			}
			const found = lintJsonPaths(document.getText(), document.uri.fsPath, {
				exists: local ? (p) => this._existsAny(p) : () => true,
				roots: inFolder ? roots : [],
				files: inFolder ? known : [],
				extensions,
				skipKeys: this._isManifest(document) ? new Set(["entry", "main"]) : undefined,
				severity: ["error", "information"].includes(config.jsonSeverity) ? config.jsonSeverity : "warning",
			});
			const suggestions = new Map();
			for (const p of found)
			{
				if (p.suggestions.length)
				{
					suggestions.set(p.line + ":" + p.col, { suggestions: p.suggestions, value: p.value });
				}
				problems.push(this._toDiagnostic(p, "pluto-lint"));
			}
			if (suggestions.size)
			{
				this.jsonSuggestions.set(key, suggestions);
			}
		}
		return problems.map(p => p instanceof vscode.Diagnostic ? p : this._toDiagnostic(p, "pluto-lint"));
	}

	_existsAny(p)
	{
		try
		{
			fs.statSync(p);
			return true;
		}
		catch (e)
		{
			return false;
		}
	}

	_lintManifest(document, config, raw)
	{
		const problems = lintManifest(document.getText(), document.uri.fsPath, this.service.index, {
			exists: document.uri.scheme == "file" ? (p) => this._exists(p) : undefined,
			checkDependencies: config.indexEnabled,
		});
		return raw ? problems : problems.map(p => this._toDiagnostic(p, "pluto-lint"));
	}

	_toDiagnostic(p, source)
	{
		const range = new vscode.Range(p.line, p.col, p.endLine, Math.max(p.endCol, p.endLine == p.line ? p.col + 1 : 0));
		const severity = p.severity == "error" ? vscode.DiagnosticSeverity.Error
			: p.severity == "information" ? vscode.DiagnosticSeverity.Information
				: p.severity == "hint" ? vscode.DiagnosticSeverity.Hint
					: vscode.DiagnosticSeverity.Warning;
		const d = new vscode.Diagnostic(range, p.message, severity);
		d.source = source;
		if (p.code)
		{
			d.code = p.code;
		}
		return d;
	}

	_runCompiler(document)
	{
		const key = document.uri.toString();
		const previous = this._runs.get(key);
		if (previous)
		{
			previous.cancel();
			this._runs.delete(key);
		}
		const isLuaFile = !this._isPluto(document);
		const found = isLuaFile ? this.luaCompiler() : this.compiler();
		const source = isLuaFile ? "lua" : "pluto";
		if (!found.path)
		{
			if (this._compiler.delete(key))
			{
				this._publish(document.uri);
			}
			return Promise.resolve();
		}
		const runId = (this._runIds.get(key) || 0) + 1;
		this._runIds.set(key, runId);
		const text = document.getText();
		const cwd = document.uri.scheme == "file" ? path.dirname(document.uri.fsPath) : undefined;
		const run = compiler.runCheck(found.path, text, { cwd, timeoutMs: 5000 });
		this._runs.set(key, run);
		return run.promise.then((result) =>
		{
			if (this._runIds.get(key) !== runId || document.isClosed)
			{
				return; // superseded
			}
			this._runs.delete(key);
			if (result.error)
			{
				// The compiler can't be started (deleted, no permission…): stop using it, quietly.
				this._log(t("diag.failedToRun", found.path, result.error.message));
				if (isLuaFile)
				{
					this._luaCompiler_ = { path: null, source: null };
				}
				else
				{
					this._compiler_ = { path: null, source: null };
				}
				this._compiler.delete(key);
				this._publish(document.uri);
				return;
			}
			if (result.timedOut)
			{
				this._log(t("diag.timeout", document.uri.fsPath));
				return;
			}
			const lines = text.split(/\r?\n/);
			const problems = compiler.parseCompilerOutput(result.output, lines);
			if (!problems.length && result.code)
			{
				this._log(t("diag.exitCode", result.code, result.output.trim()));
			}
			const diagnostics = problems.map((p) =>
			{
				const line = Math.min(p.line, Math.max(0, document.lineCount - 1));
				const lineText = lines[line] || "";
				let col = p.col;
				let endCol = p.endCol;
				if (col === null)
				{
					// No column: underline the whole line (without its indentation).
					col = lineText.length - lineText.replace(/^\s+/, "").length;
					endCol = Math.max(col + 1, lineText.replace(/\s+$/, "").length);
				}
				return this._toDiagnostic({ line, col, endLine: line, endCol: Math.max(endCol, col + 1), severity: p.severity, message: p.message }, source);
			});
			this._compiler.set(key, diagnostics);
			this._publish(document.uri);
		});
	}

	_publish(uri)
	{
		const key = uri.toString();
		const all = [...(this._compiler.get(key) || []), ...(this._lint.get(key) || [])];
		this.collection.set(uri, all);
	}

	clear(uri)
	{
		const key = uri.toString();
		clearTimeout(this._timers.get(key));
		this._timers.delete(key);
		const run = this._runs.get(key);
		if (run)
		{
			run.cancel();
			this._runs.delete(key);
		}
		this._runIds.set(key, (this._runIds.get(key) || 0) + 1);
		this._compiler.delete(key);
		this._lint.delete(key);
		this.collection.delete(uri);
	}

	/** Re-checks all open documents (built-in checks only, unless `withCompiler`). */
	recheckAll(withCompiler)
	{
		const config = this._config();
		for (const document of vscode.workspace.textDocuments)
		{
			if (!this._isRelevant(document))
			{
				continue;
			}
			if (!config.enabled || !this._isChecked(document, config))
			{
				this.clear(document.uri);
			}
			else if (withCompiler)
			{
				this.check(document);
			}
			else
			{
				const key = document.uri.toString();
				try
				{
					this._lint.set(key, this._isManifest(document) || this._isJsonPaths(document, config) ? this._lintJson(document, config) : this._lintSource(document, config));
				}
				catch (e)
				{
					console.error("Pluto: lint failed", e);
				}
				this._publish(document.uri);
			}
		}
	}

	/** Re-runs the built-in checks of open documents soon, e.g. after files were added or removed. */
	recheckSoon()
	{
		clearTimeout(this._relintTimer);
		this._relintTimer = setTimeout(() => this.recheckAll(false), 500);
	}

	dispose()
	{
		clearTimeout(this._relintTimer);
		for (const timer of this._timers.values())
		{
			clearTimeout(timer);
		}
		for (const run of this._runs.values())
		{
			run.cancel();
		}
		this._timers.clear();
		this._runs.clear();
		this.collection.dispose();
		if (this.output)
		{
			this.output.dispose();
		}
	}
}

/**
 * Wires the diagnostics to editor and workspace events.
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 * @param {Promise<void>} indexed Resolves when the first workspace scan has finished.
 */
function registerDiagnostics(context, service, indexed)
{
	const manager = new DiagnosticsManager(service);
	context.subscriptions.push(
		manager,
		vscode.workspace.onDidChangeTextDocument(function (event)
		{
			if (event.contentChanges.length)
			{
				manager.schedule(event.document);
			}
		}),
		vscode.workspace.onDidOpenTextDocument(document => manager.schedule(document, true)),
		vscode.workspace.onDidSaveTextDocument(document => manager.schedule(document, true)),
		vscode.workspace.onDidCloseTextDocument(document => manager.clear(document.uri)),
		vscode.workspace.onDidChangeConfiguration(function (event)
		{
			if (event.affectsConfiguration("pluto.language"))
			{
				manager.recheckAll(false); // the messages of the built-in checks change with the language
			}
			else if (event.affectsConfiguration("pluto.lua"))
			{
				manager.resetCompiler();
				manager.recheckAll(true);
				manager.recheckSoon(); // once the index has been rebuilt
			}
			else if (event.affectsConfiguration("pluto.format"))
			{
				manager.recheckAll(false); // the check of the closing brackets is a setting there
			}
			else if (event.affectsConfiguration("pluto.json"))
			{
				manager.invalidateFiles();
				manager.recheckAll(false);
			}
			else if (event.affectsConfiguration("pluto.diagnostics"))
			{
				manager.resetCompiler();
				manager.recheckAll(true);
			}
			else if (event.affectsConfiguration("pluto.index"))
			{
				manager.recheckSoon();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(function ()
		{
			manager.resetCompiler();
			manager.recheckSoon();
		})
	);
	if (vscode.workspace.onDidGrantWorkspaceTrust)
	{
		context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(function ()
		{
			manager.resetCompiler();
			manager.recheckAll(true);
		}));
	}
	// Other files appearing or disappearing can fix or break `require`s and manifest entries.
	const watcher = vscode.workspace.createFileSystemWatcher("**/{*.pluto,*.lua,info.json}");
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(() => manager.recheckSoon()),
		watcher.onDidChange(uri => MANIFEST.test(uri.path) && manager.recheckSoon()),
		watcher.onDidDelete(() => manager.recheckSoon())
	);

	// Paths in JSON files: a file created, deleted or renamed can fix or break them. (A watcher on everything is
	// only needed with `pluto.json.checkAllPaths`; creating one on demand keeps the default cheap.)
	let everything = null;
	const watchEverything = function ()
	{
		if (everything || !vscode.workspace.getConfiguration("pluto").get("json.checkAllPaths", false))
		{
			return;
		}
		everything = vscode.workspace.createFileSystemWatcher("**/*");
		context.subscriptions.push(everything, everything.onDidCreate(() => manager.invalidateFiles()), everything.onDidDelete(() => manager.invalidateFiles()));
	};
	watchEverything();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration("pluto.json") && watchEverything()));
	context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
		[{ language: "json" }, { language: "jsonc" }],
		{
			provideCodeActions(document, range, actionContext)
			{
				const actions = [];
				const found = manager.jsonSuggestions.get(document.uri.toString());
				for (const d of actionContext.diagnostics)
				{
					const item = d.code == "json-path" && found && found.get(d.range.start.line + ":" + d.range.start.character);
					for (const suggestion of item ? item.suggestions : [])
					{
						const action = new vscode.CodeAction(t("json.replaceWith", suggestion), vscode.CodeActionKind.QuickFix);
						action.diagnostics = [d];
						action.isPreferred = suggestion == item.suggestions[0];
						action.edit = new vscode.WorkspaceEdit();
						action.edit.replace(document.uri, new vscode.Range(d.range.start.line, d.range.start.character + 1, d.range.end.line, Math.max(d.range.start.character + 1, d.range.end.character - 1)), suggestion);
						actions.push(action);
					}
				}
				return actions;
			},
		},
		{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
	));

	// Built-in checks need the index, so check open documents once it is built.
	Promise.resolve(indexed).catch(() => {}).then(() => manager.recheckAll(true));
	return manager;
}

module.exports = { DiagnosticsManager, registerDiagnostics };
