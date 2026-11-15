// Editor side of ./autoFormat: a new line after the comma (after a pause), a closing bracket that does not fit
// replaced after a pause, the suggestions shown in grey (`()` after `function`, ` = ` after `["key"]`, ` then` /
// ` do` after a block header) and the quick fix for a closer that does not fit.

"use strict";

const vscode = require("vscode");
const { planCommaNewLine, inlineSuggestionAt, findBracketMismatches } = require("./autoFormat");
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

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerAutoFormat(context, service)
{
	const applies = (document) => document.languageId == "pluto" || (document.languageId == "lua" && service.luaEnabled());
	const settings = (document) => vscode.workspace.getConfiguration("pluto", document.uri);

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
	if (vscode.languages.registerInlineCompletionItemProvider && vscode.InlineCompletionItem)
	{
		context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider([{ language: "pluto" }, { language: "lua" }], {
			provideInlineCompletionItems(document, position)
			{
				const s = suggestionAt(document, position);
				if (!s)
				{
					return undefined;
				}
				const insert = s.snippet ? new vscode.SnippetString(s.snippet) : s.insert;
				return [new vscode.InlineCompletionItem(insert, new vscode.Range(position, position))];
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

module.exports = { registerAutoFormat, indentUnit };
