// The part of the live directives that lives in the editor: the grey note and the hover, Enter / pause / Escape handling,
// completion after `#` and `>`. The rules are in ./liveDirectives.

"use strict";

const vscode = require("vscode");
const live = require("./liveDirectives");
const { minimalEdit } = require("./returnHint");
const { setDirectivePrefix } = require("./hints");
const { t } = require("./i18n");

const PAUSE_MS = 700;
const PAINT_DELAY_MS = 120;
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function readOptions(document)
{
	const config = vscode.workspace.getConfiguration("plua", document ? document.uri : undefined);
	const num = (key, def, min, max) => Math.min(max, Math.max(min, Math.round(Number(config.get(key, def))) || def));
	return {
		enabled: config.get("liveDirectives.enabled", true) !== false,
		maxPreviewLength: num("liveDirectives.maxPreviewLength", 60, 10, 500),
		maxContextLines: num("liveDirectives.maxContextLines", 3, 1, 30),
		maxSearchDistance: num("liveDirectives.maxSearchDistance", 200, 5, 5000),
		completion: config.get("liveDirectives.completion", true) !== false,
		inComments: config.get("liveDirectives.inComments", true) !== false,
		returnDirective: config.get("returnHelper.enableReturnDirective", true) !== false,
		allowModify: config.get("liveDirectives.allowModify", true) !== false,
		skipConst: config.get("liveDirectives.skipConst", true) !== false,
		ignoredTargets: config.get("liveDirectives.ignoredTargets", []),
		prefix: config.get("liveDirectives.prefix", "#"),
		commandSeparator: config.get("liveDirectives.commandSeparator", ">"),
		commandAliases: config.get("liveDirectives.commandAliases", {}),
	};
}

/** Whether a directive is to be looked at at all under the options. */
function wanted(dir, options)
{
	return !!dir && options.enabled && (!dir.comment || options.inComments) && !live.isIgnored(dir.target, options.ignoredTargets)
		&& (!live.isModifying(dir) || options.allowModify)
		&& (dir.target != "return" || dir.comment || options.returnDirective || dir.op != "=");
}

/**
 * @param {vscode.ExtensionContext} context
 */
function registerLiveDirectives(context)
{
	if (!vscode.window.createTextEditorDecorationType || !vscode.workspace.onDidChangeTextDocument)
	{
		return;
	}
	const isPluto = (document) => document.languageId == "pluto";
	const decoration = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor("editorGhostText.foreground"), fontStyle: "italic", margin: "0 0 0 2em" },
	});
	context.subscriptions.push(decoration);
	let busy = false;
	let paintTimer = null;
	let pauseTimer = null;

	const gotoLink = (document, line, label) => "[" + label + "](command:plua.liveDirectives.goto?" + encodeURIComponent(JSON.stringify([document.uri.toString(), line])) + ")";
	const inline = (text) => "`" + String(text).split("`").join("'") + "`";

	const hoverFor = function (document, preview)
	{
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = true;
		md.supportHtml = false;
		if (preview.steps && preview.steps.length)
		{
			md.appendMarkdown("**" + t("liveDir.hoverSteps") + "**\n\n");
			preview.steps.forEach(function (step, i)
			{
				md.appendCodeblock(step.text, "pluto");
				md.appendMarkdown(gotoLink(document, step.line, t("liveDir.goto", step.line + 1)) + (i + 1 < preview.steps.length ? "\n\n" : ""));
			});
			return md;
		}
		if (preview.places && preview.places.length)
		{
			md.appendMarkdown("**" + t("liveDir.hoverPlaces") + "**\n\n");
			for (const place of preview.places.slice(0, 30))
			{
				const kind = t("liveDir.kind." + place.kind);
				md.appendMarkdown("- " + gotoLink(document, place.line, t("liveDir.placeShort", place.line + 1, kind)) + (place.where ? " (" + place.where + ")" : "") + " " + inline(place.text) + "\n");
			}
			return md;
		}
		if (preview.context)
		{
			md.appendCodeblock(preview.context.lines.join(LF), "pluto");
		}
		if (preview.found)
		{
			md.appendMarkdown(gotoLink(document, preview.found.line, t("liveDir.goto", preview.found.line + 1)));
		}
		return md;
	};

	// A variable that is not read: the name is faded out and a quick fix removes the declaration.
	const hints = vscode.languages.createDiagnosticCollection ? vscode.languages.createDiagnosticCollection("plua-live-directives") : null;
	if (hints)
	{
		context.subscriptions.push(hints);
	}
	const unusedByDocument = new Map();

	const paint = function (editor)
	{
		const document = editor.document;
		if (!isPluto(document))
		{
			return;
		}
		const options = readOptions(document);
		const items = [];
		const unused = [];
		if (options.enabled)
		{
			const text = document.getText().split(CR).join("");
			const lines = text.split(LF);
			for (let i = 0; i < lines.length; ++i)
			{
				if (!lines[i].includes("#"))
				{
					continue;
				}
				const dir = live.parseDirective(lines[i], options);
				if (!live.isActive(dir) || !wanted(dir, options))
				{
					continue;
				}
				const preview = live.previewFor(text, i, dir, options);
				if (!preview)
				{
					continue;
				}
				const end = document.lineAt(i).range.end;
				items.push({
					range: new vscode.Range(end, end),
					hoverMessage: hoverFor(document, preview),
					renderOptions: { after: { contentText: preview.preview } },
				});
				if (dir.op == "unused" && preview.declaration)
				{
					unused.push({ directiveLine: i, declarationLine: preview.declaration.line, name: dir.target, text: preview.declaration.text });
				}
			}
		}
		editor.setDecorations(decoration, items);
		unusedByDocument.set(document.uri.toString(), unused);
		if (hints)
		{
			hints.set(document.uri, unused.map(function (u)
			{
				const declaration = document.lineAt(u.declarationLine).text;
				const col = Math.max(0, declaration.indexOf(u.name));
				const diagnostic = new vscode.Diagnostic(new vscode.Range(u.declarationLine, col, u.declarationLine, col + u.name.length), t("liveDir.unusedNote", u.name), vscode.DiagnosticSeverity.Hint);
				diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
				diagnostic.source = "plua";
				return diagnostic;
			}));
		}
	};
	const paintAll = () => vscode.window.visibleTextEditors.forEach(paint);
	const paintSoon = function ()
	{
		if (paintTimer)
		{
			clearTimeout(paintTimer);
		}
		paintTimer = setTimeout(function () { paintTimer = null; paintAll(); updateContext(); }, PAINT_DELAY_MS);
	};

	// The Escape key removes a temporary `>show` line: it works while the cursor is on one.
	const updateContext = function ()
	{
		const editor = vscode.window.activeTextEditor;
		let on = false;
		if (editor && isPluto(editor.document) && editor.selections.length == 1)
		{
			const dir = live.parseDirective(editor.document.lineAt(editor.selection.active.line).text, readOptions(editor.document));
			on = !!dir && !dir.comment && live.isActive(dir) && !live.isModifying(dir) && wanted(dir, readOptions(editor.document));
		}
		vscode.commands.executeCommand("setContext", "plua.onDirectiveLine", on);
	};

	/** Puts a text (with LF breaks) in place of the document's with one edit, so that one Ctrl+Z takes it back. */
	const replaceText = function (document, plain, next)
	{
		const change = minimalEdit(plain, next);
		const crlf = document.eol == vscode.EndOfLine.CRLF;
		const toOffset = (n) => (crlf ? n + plain.slice(0, n).split(LF).length - 1 : n);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(toOffset(change.start)), document.positionAt(toOffset(change.end))),
			crlf ? change.text.split(LF).join(CR + LF) : change.text);
		busy = true;
		return vscode.workspace.applyEdit(edit).then(function () { busy = false; }, function () { busy = false; });
	};

	const removeLine = function (document, line)
	{
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, line + 1 < document.lineCount
			? new vscode.Range(line, 0, line + 1, 0)
			: new vscode.Range(document.lineAt(line).range.start, document.lineAt(line).range.end));
		busy = true;
		return vscode.workspace.applyEdit(edit).then(function () { busy = false; }, function () { busy = false; });
	};

	/** Carries out the directive on a line: `=` makes the change, `>show_*` just goes. */
	const run = function (document, line, onEnter)
	{
		if (line >= document.lineCount)
		{
			return;
		}
		const options = readOptions(document);
		const dir = live.parseDirective(document.lineAt(line).text, options);
		if (!live.isActive(dir) || !wanted(dir, options))
		{
			return;
		}
		if (!live.isModifying(dir))
		{
			// The commands that only look: the temporary line goes on Enter, the one in a comment stays.
			if (onEnter && !dir.comment)
			{
				removeLine(document, line);
			}
			return;
		}
		const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
		const eo = editor ? editor.options : {};
		const unit = eo.insertSpaces === false ? "\t" : " ".repeat(Number(eo.tabSize) || 4);
		const plain = document.getText().split(CR).join("");
		const result = live.applyDirectiveCommand(plain, line, dir, unit, LF, options);
		if (result.text !== null)
		{
			replaceText(document, plain, result.text);
		}
	};

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (!isPluto(document) || event.contentChanges.length == 0)
		{
			return;
		}
		paintSoon();
		if (busy)
		{
			return;
		}
		const reasons = vscode.TextDocumentChangeReason;
		if (reasons && (event.reason === reasons.Undo || event.reason === reasons.Redo))
		{
			return;
		}
		const options = readOptions(document);
		if (!options.enabled)
		{
			return;
		}
		const enter = event.contentChanges.find(c => c.rangeLength == 0 && /^(?:\r\n|\n)[ \t]*$/.test(c.text));
		if (enter)
		{
			run(document, enter.range.start.line, true);
			return;
		}
		// `#return = value` is also carried out after a pause.
		const lineNo = event.contentChanges[0].range.start.line;
		if (lineNo < document.lineCount)
		{
			const dir = live.parseDirective(document.lineAt(lineNo).text, options);
			if (dir && !dir.comment && dir.op == "=" && dir.target == "return" && dir.expr != "" && options.returnDirective)
			{
				if (pauseTimer)
				{
					clearTimeout(pauseTimer);
				}
				pauseTimer = setTimeout(function () { pauseTimer = null; run(document, lineNo, false); }, PAUSE_MS);
			}
		}
	}));
	if (vscode.window.onDidChangeTextEditorSelection)
	{
		context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(function () { updateContext(); }));
	}
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(paintAll));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event)
	{
		if (event.affectsConfiguration("plua.liveDirectives") || event.affectsConfiguration("plua.returnHelper.enableReturnDirective"))
		{
			paintAll();
			updateContext();
		}
	}));
	context.subscriptions.push({ dispose: () => { if (paintTimer) { clearTimeout(paintTimer); } if (pauseTimer) { clearTimeout(pauseTimer); } } });

	context.subscriptions.push(vscode.commands.registerCommand("plua.liveDirectives.dismiss", function ()
	{
		const editor = vscode.window.activeTextEditor;
		if (editor && isPluto(editor.document) && editor.selections.length == 1)
		{
			const line = editor.selection.active.line;
			const dir = live.parseDirective(editor.document.lineAt(line).text, readOptions(editor.document));
			if (dir && !dir.comment && live.isActive(dir) && !live.isModifying(dir))
			{
				return removeLine(editor.document, line);
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand("plua.liveDirectives.removeDeclaration", async function (uriText, line, expected)
	{
		const document = vscode.workspace.textDocuments.find(d => d.uri.toString() == uriText);
		if (!document || typeof line != "number" || line < 0 || line >= document.lineCount || document.lineAt(line).text.trim() != expected)
		{
			return; // the text has changed since the quick fix was offered
		}
		await removeLine(document, line);
	}));
	if (vscode.languages.registerCodeActionsProvider)
	{
		context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{ language: "pluto" }], {
			provideCodeActions(document, range)
			{
				const out = [];
				for (const u of unusedByDocument.get(document.uri.toString()) || [])
				{
					const at = (n) => range.start.line <= n && n <= range.end.line;
					if (at(u.directiveLine) || at(u.declarationLine))
					{
						const action = new vscode.CodeAction(t("liveDir.removeDecl", u.name, u.declarationLine + 1), vscode.CodeActionKind.QuickFix);
						action.command = { command: "plua.liveDirectives.removeDeclaration", title: action.title, arguments: [document.uri.toString(), u.declarationLine, u.text] };
						out.push(action);
					}
				}
				return out;
			},
		}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
	}
	context.subscriptions.push(vscode.commands.registerCommand("plua.liveDirectives.goto", async function (uriText, line)
	{
		const document = vscode.workspace.textDocuments.find(d => d.uri.toString() == uriText);
		if (!document || typeof line != "number" || line < 0 || line >= document.lineCount)
		{
			return;
		}
		const editor = await vscode.window.showTextDocument(document);
		const range = document.lineAt(line).range;
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}));

	// Completion: the targets after the prefix (`#`), the commands after the separator (`>`). The characters that start it
	// follow the settings, so the provider is made again when they change.
	const kinds = { keyword: "Keyword", variable: "Variable", parameter: "Variable", field: "Field", command: "Function" };
	const provider = {
		provideCompletionItems(document, position)
		{
			const options = readOptions(document);
			if (!options.enabled || !options.completion)
			{
				return [];
			}
			const lineText = document.lineAt(position.line).text;
			const prefix = lineText.slice(0, position.character);
			const dir = live.parseDirective(prefix, options);
			if ((dir && dir.comment && !options.inComments) || !prefix.includes(live.syntaxOf(options).prefix))
			{
				return [];
			}
			const items = live.completionsFor(document.getText().split(CR).join(""), position.line, position.character, options);
			const startCol = prefix.search(/[\w.]*$/);
			const range = new vscode.Range(position.line, startCol, position.line, position.character);
			return items.map(function (it, index)
			{
				const item = new vscode.CompletionItem(it.label, vscode.CompletionItemKind[kinds[it.kind]]);
				item.detail = it.detail;
				if (it.documentation)
				{
					item.documentation = it.documentation;
				}
				item.range = range;
				item.sortText = String(index).padStart(4, "0");
				return item;
			});
		},
	};
	let completionRegistration = null;
	const registerCompletion = function ()
	{
		if (!vscode.languages.registerCompletionItemProvider)
		{
			return;
		}
		if (completionRegistration)
		{
			completionRegistration.dispose();
		}
		const syntax = live.syntaxOf(readOptions());
		const triggers = new Set(["#", ">", ".", " ", syntax.prefix.slice(-1), syntax.separator.slice(-1)]);
		completionRegistration = vscode.languages.registerCompletionItemProvider([{ language: "pluto" }], provider, ...triggers);
	};
	registerCompletion();
	context.subscriptions.push({ dispose: () => { if (completionRegistration) { completionRegistration.dispose(); } } });
	setDirectivePrefix(readOptions().prefix);
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event)
	{
		if (event.affectsConfiguration("plua.liveDirectives"))
		{
			setDirectivePrefix(readOptions().prefix);
			registerCompletion();
			paintAll();
			updateContext();
		}
	}));
	paintAll();
}

module.exports = { registerLiveDirectives, readOptions, wanted };
