// Editor side of ./autoFormat: a new line after the comma (after a pause), a closing bracket that does not fit
// replaced after a pause, the suggestions shown in grey (`()` after `function`, ` = ` after `["key"]`, ` then` /
// ` do` after a block header) and the quick fix for a closer that does not fit.

"use strict";

const vscode = require("vscode");
const fs = require("fs");
const { planCommaNewLine, inlineSuggestionAt, inlineSuggestionsAt, partialWordAt, finishWord, findBracketMismatches, countIfStyles, chooseIfWord, namesFor } = require("./autoFormat");
const { suggestionsAt, constructorSuggestionsAt } = require("./hints");
const { classChecker } = require("./defaultValuesEditor");
const { t } = require("./i18n");

function tabSizeOf(editor)
{
	return Number(editor.options.tabSize) || 4;
}

/** One level of indentation as the editor is set up: a tab, or `tabSize` spaces. */
function indentUnit(editor)
{
	return editor.options.insertSpaces === false ? "\t" : " ".repeat(tabSizeOf(editor));
}

// What the other files of the workspace use after `if`: `then` or `do`. Read from the disk once, kept for a while.
const fileCounts = new Map();
let workspaceCounts = null;

/**
 * @param {import("./extension").LanguageService} service
 * @returns {Promise<{ then: number, do: number }>}
 */
async function workspaceIfCounts(service)
{
	if (workspaceCounts && Date.now() - workspaceCounts.at < 5000)
	{
		return workspaceCounts.counts;
	}
	const total = { then: 0, do: 0 };
	let seen = 0;
	for (const file of service.index.files.values())
	{
		if (++seen > 400)
		{
			break;
		}
		try
		{
			const stat = await fs.promises.stat(file.path);
			if (stat.size > 300 * 1024)
			{
				continue;
			}
			let cached = fileCounts.get(file.path);
			if (!cached || cached.mtimeMs != stat.mtimeMs || cached.size != stat.size)
			{
				cached = { mtimeMs: stat.mtimeMs, size: stat.size, counts: countIfStyles(await fs.promises.readFile(file.path, "utf8")) };
				fileCounts.set(file.path, cached);
			}
			total.then += cached.counts.then;
			total.do += cached.counts.do;
		}
		catch (e)
		{
			// a file that is gone or can't be read does not vote
		}
	}
	workspaceCounts = { at: Date.now(), counts: total };
	return total;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerAutoFormat(context, service)
{
	const applies = (document) => document.languageId == "pluto" || (document.languageId == "lua" && service.luaEnabled());
	const settings = (document) => vscode.workspace.getConfiguration("plua", document.uri);

	// One action waits at a time (a pause after typing). Typing, or moving the cursor away, cancels it.
	let pending = null;
	const cancel = function ()
	{
		if (pending)
		{
			clearTimeout(pending.timer);
			pending = null;
		}
	};
	/**
	 * Runs `run` after `delay` ms if nothing has changed since: the same version of the document, the cursor in place.
	 * @param {vscode.TextDocument} document
	 * @param {vscode.Position} cursor Where the cursor is after the typed character.
	 */
	const arm = function (document, cursor, delay, run)
	{
		cancel();
		const mine = { document, version: document.version, cursor, timer: null };
		mine.timer = setTimeout(function ()
		{
			if (pending !== mine)
			{
				return;
			}
			pending = null;
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== document || document.version != mine.version || editor.selections.length != 1
				|| !editor.selection.isEmpty || !editor.selection.active.isEqual(cursor))
			{
				return;
			}
			run(editor);
		}, Math.max(30, delay)); // even "at once" waits a moment, until the editor has moved the cursor
		pending = mine;
	};

	/** Applies the edits of a plan and puts the cursor where it says. */
	const apply = function (editor, plan)
	{
		return editor.edit(function (builder)
		{
			for (const e of plan.edits)
			{
				builder.replace(new vscode.Range(e.line, e.col, e.endLine, e.endCol), e.text);
			}
		}, { undoStopBefore: true, undoStopAfter: false }).then(function (ok)
		{
			if (ok && plan.cursor)
			{
				const pos = new vscode.Position(plan.cursor.line, plan.cursor.col);
				editor.selection = new vscode.Selection(pos, pos);
			}
		});
	};

	context.subscriptions.push(
		{ dispose: cancel },
		vscode.workspace.onDidChangeTextDocument(function (event)
		{
			const document = event.document;
			if (pending && pending.document === document && document.version != pending.version)
			{
				cancel(); // the user went on typing
			}
			if (!applies(document) || event.contentChanges.length != 1 || event.reason == vscode.TextDocumentChangeReason.Undo || event.reason == vscode.TextDocumentChangeReason.Redo)
			{
				return;
			}
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document !== document || editor.selections.length != 1)
			{
				return;
			}
			const change = event.contentChanges[0];
			if (change.rangeLength != 0)
			{
				return;
			}
			const config = settings(document);
			const cursor = new vscode.Position(change.range.start.line, change.range.start.character + change.text.length);
			const eol = document.eol == vscode.EndOfLine.CRLF ? "\r\n" : "\n";
			if (change.text == "," && config.get("format.newLineAfterComma", true) !== false)
			{
				// A comma at the end of an element of a multi-line list: a new line, unless you go on typing.
				const lineText = document.lineAt(cursor.line).text;
				if (/^\s*(?:--.*)?$/.test(lineText.slice(cursor.character)))
				{
					const options = {
						params: config.get("format.multilineParams", true) !== false,
						tables: config.get("format.multilineTables", true) !== false,
					};
					const plan = planCommaNewLine(document.getText(), cursor.line, options, indentUnit(editor), eol);
					if (plan)
					{
						arm(document, cursor, Number(config.get("format.newLineAfterCommaDelayMs", 700)) || 0, (e) => apply(e, plan));
					}
				}
			}
			else if (/^[)\]}]$/.test(change.text) && config.get("format.fixMismatchedBrackets", "suggest") == "auto")
			{
				// A closer that does not fit the last opened bracket: replaced after a pause.
				const offset = document.offsetAt(change.range.start);
				const wrong = findBracketMismatches(document.getText()).find(m => m.off == offset);
				if (wrong)
				{
					arm(document, cursor, Number(config.get("format.fixMismatchedBracketsDelayMs", 1200)) || 0, function (e)
					{
						const still = findBracketMismatches(document.getText()).find(m => m.off == offset);
						if (still)
						{
							e.edit(b => b.replace(new vscode.Range(still.line, still.col, still.line, still.endCol), still.expected), { undoStopBefore: true, undoStopAfter: false });
						}
					});
				}
			}
		}),
		vscode.window.onDidChangeTextEditorSelection(function (event)
		{
			if (!pending || event.textEditor.document !== pending.document)
			{
				return;
			}
			const sel = event.selections[0];
			// The cursor that moved by typing the character itself is no reason to cancel.
			if (event.selections.length != 1 || !sel.isEmpty || !sel.active.isEqual(pending.cursor) || pending.document.version != pending.version)
			{
				cancel();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(cancel)
	);

	// The quick fix of a closer that does not fit.
	context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
		[{ language: "pluto" }, { language: "lua" }],
		{
			provideCodeActions(document, range, actionContext)
			{
				if (!applies(document) || settings(document).get("format.fixMismatchedBrackets", "suggest") == "off")
				{
					return [];
				}
				const found = findBracketMismatches(document.getText());
				const actions = [];
				for (const d of actionContext.diagnostics)
				{
					const m = d.code == "bracket-mismatch" && found.find(f => f.line == d.range.start.line && f.col == d.range.start.character);
					if (m)
					{
						const action = new vscode.CodeAction(t("bracket.replaceWith", m.found, m.expected), vscode.CodeActionKind.QuickFix);
						action.diagnostics = [d];
						action.isPreferred = true;
						action.edit = new vscode.WorkspaceEdit();
						action.edit.replace(document.uri, new vscode.Range(m.line, m.col, m.line, m.endCol), m.expected);
						actions.push(action);
					}
				}
				return actions;
			},
		},
		{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
	));

	// The suggestions in grey: `Tab` takes them.
	const suggestionAt = function (document, position)
	{
		if (!applies(document))
		{
			return null;
		}
		const config = settings(document);
		const options = {
			parens: config.get("format.suggestParens", true) !== false,
			keyAssign: config.get("format.suggestTableKeyAssign", true) !== false,
			blockWords: config.get("format.suggestBlockWords", true) !== false,
		};
		if (!options.parens && !options.keyAssign && !options.blockWords)
		{
			return null;
		}
		return inlineSuggestionAt(document.getText(), document.offsetAt(position), options);
	};
	// The hints that wait for the cursor to rest: a colon after a parameter, a return type, a `case`. After the pause the
	// grey text is asked for; while the list of completions is open it is not shown, and it is asked for again until
	// that list is closed.
	let rest = null;
	const stopRest = function ()
	{
		if (rest)
		{
			clearTimeout(rest.timer);
			clearInterval(rest.poll);
			rest = null;
		}
	};
	const hintOptions = function (document)
	{
		const config = settings(document);
		return {
			paramType: config.get("format.suggestParamType", true) !== false,
			returnType: config.get("format.suggestReturnType", true) !== false,
			returnValue: config.get("format.suggestReturnValue", true) !== false,
			caseColon: config.get("format.suggestCaseColon", true) !== false,
			caseBreak: config.get("format.suggestCaseBreak", true) !== false,
			caseWords: config.get("format.suggestCaseWords", true) !== false,
		};
	};
	const considerRest = function (editor)
	{
		stopRest();
		const document = editor && editor.document;
		if (!document || document.languageId != "pluto" || editor.selections.length != 1 || !editor.selection.isEmpty)
		{
			return;
		}
		const offset = document.offsetAt(editor.selection.active);
		const found = suggestionsAt(document.getText(), offset, hintOptions(document), {}).filter(s => s.paused);
		if (!found.length)
		{
			return;
		}
		const delay = Math.max(30, Number(settings(document).get("format.suggestParamTypeDelayMs", 600)) || 0);
		const mine = { uri: document.uri.toString(), version: document.version, offset, armed: false, shown: false, timer: null, poll: null, tries: 0 };
		const valid = () => rest === mine && vscode.window.activeTextEditor === editor && document.version == mine.version
			&& editor.selection.isEmpty && document.offsetAt(editor.selection.active) == offset;
		const trigger = () => vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
		mine.timer = setTimeout(function ()
		{
			if (!valid())
			{
				return;
			}
			mine.armed = true;
			trigger();
			// While the list of completions is open the grey text is not shown: look again until it has been shown.
			mine.poll = setInterval(function ()
			{
				if (!valid() || mine.shown || ++mine.tries > 120)
				{
					clearInterval(mine.poll);
					return;
				}
				trigger();
			}, 500);
		}, delay);
		rest = mine;
	};
	context.subscriptions.push(
		{ dispose: stopRest },
		vscode.window.onDidChangeTextEditorSelection(event => considerRest(event.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(editor => editor ? considerRest(editor) : stopRest())
	);

	if (vscode.languages.registerInlineCompletionItemProvider && vscode.InlineCompletionItem)
	{
		context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider([{ language: "pluto" }, { language: "lua" }], {
			async provideInlineCompletionItems(document, position, inlineContext)
			{
				if (!applies(document))
				{
					return undefined;
				}
				const config = settings(document);
				const options = {
					parens: config.get("format.suggestParens", true) !== false,
					keyAssign: config.get("format.suggestTableKeyAssign", true) !== false,
					blockWords: config.get("format.suggestBlockWords", true) !== false,
					forHints: config.get("format.suggestFor", true) !== false,
					names: namesFor(config.get("format.nameStyle", "short"), config.get("format.names")),
				};
				const text = document.getText();
				const offset = document.offsetAt(position);
				const items = [];
				// A class without a constructor: it comes first, the plain `()` after it.
				if (config.get("format.suggestConstructor", true) !== false && document.languageId == "pluto")
				{
					const ctor = constructorSuggestionsAt(text, offset);
					ctor.forEach((c) => items.push(new vscode.InlineCompletionItem(new vscode.SnippetString(c.snippet), new vscode.Range(position, position))));
				}
				const add = (s) => items.push(new vscode.InlineCompletionItem(s.snippet ? new vscode.SnippetString(s.snippet) : s.insert, new vscode.Range(position, position),
					s.command ? { command: s.command, title: "" } : undefined));
				if (options.blockWords && /^\s*(?:else)?if\b/.test(document.lineAt(position.line).text.slice(0, position.character)))
				{
					// `then` or `do` after an `if`: by the setting, or by what the file (then the workspace) uses.
					const setting = config.get("format.ifBlockWord", "auto");
					let word = chooseIfWord(setting, countIfStyles(text));
					if (setting == "auto" && countIfStyles(text).then == countIfStyles(text).do)
					{
						word = chooseIfWord(setting, countIfStyles(text), await workspaceIfCounts(service));
					}
					options.ifWord = word;
				}
				// All the suggestions of a text at a place (those of the `format` family and the hints).
				const gather = (src, at) =>
				{
					const list = [];
					if (options.parens || options.keyAssign || options.blockWords || options.forHints)
					{
						inlineSuggestionsAt(src, at, options).forEach((s) => list.push(s));
					}
					if (document.languageId == "pluto")
					{
						suggestionsAt(src, at, hintOptions(document), { isClass: classChecker(service, document, position.line), unit: "    " }).forEach((s) => list.push(s));
					}
					return list;
				};
				// A word that is half typed (`th`): what goes on with it, as if the word was not there yet. Its rest is
				// shown (`en`); the suggestions for the line with the half word as a name of its own (` then`) give way.
				const partial = partialWordAt(text, offset);
				// After an `if` both `then` and `do` are right: with a part of either typed, the one it belongs to is finished.
				const finishing = [];
				if (partial)
				{
					const preferred = options.ifWord;
					for (const word of preferred ? ["then", "do"] : [preferred])
					{
						options.ifWord = word;
						for (const s of finishWord(gather(partial.text, partial.offset), partial.word))
						{
							if (!finishing.some((f) => f.insert == s.insert && f.snippet == s.snippet))
							{
								finishing.push(s);
							}
						}
					}
					options.ifWord = preferred;
				}
				const open = !!(inlineContext && inlineContext.selectedCompletionInfo); // the list of completions is open
				for (const s of finishing.length ? finishing : gather(text, offset))
				{
					if (!s.paused)
					{
						add(s);
					}
					else if (rest && rest.armed && !open && rest.uri == document.uri.toString() && rest.version == document.version && rest.offset == offset)
					{
						rest.shown = true;
						add(s);
					}
				}
				return items.length ? items : undefined;
			},
		}));
	}
	// With inline suggestions switched off, the same `()` is an item of the list.
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider([{ language: "pluto" }, { language: "lua" }], {
		provideCompletionItems(document, position)
		{
			if (vscode.workspace.getConfiguration("editor", document.uri).get("inlineSuggest.enabled", true) !== false)
			{
				return undefined;
			}
			const s = suggestionAt(document, position);
			if (!s || s.kind != "parens")
			{
				return undefined;
			}
			const item = new vscode.CompletionItem("()", vscode.CompletionItemKind.Snippet);
			item.insertText = new vscode.SnippetString(s.snippet);
			item.range = new vscode.Range(position, position);
			item.detail = t("parens.detail");
			item.sortText = "0";
			return [item];
		},
	}));
}

module.exports = { registerAutoFormat, indentUnit, workspaceIfCounts };
