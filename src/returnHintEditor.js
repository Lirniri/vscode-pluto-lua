// The part of the return hint that lives in the editor: it watches the functions of the open Pluto files, removes a bare
// `return` when the return type of its function was taken away, shows the grey note for a `return` with a value (with a hover that
// has the code and the offer to remove it) and the quick fix. The rules are in ./returnHint.

"use strict";

const vscode = require("vscode");
const { findFunctionShapes } = require("./hints");
const hint = require("./returnHint");
const { t } = require("./i18n");

const REMOVE_DELAY_MS = 600;

function readOptions(document)
{
	const config = vscode.workspace.getConfiguration("plua", document ? document.uri : undefined);
	return {
		autoReturn: config.get("format.autoReturn", true) !== false,
		note: config.get("diagnostics.returnHint", true) !== false,
	};
}

const shapesOf = (text) =>
{
	try
	{
		return findFunctionShapes(text);
	}
	catch (e)
	{
		return [];
	}
};

/**
 * @param {vscode.ExtensionContext} context
 */
function registerReturnHint(context)
{
	if (!vscode.window.createTextEditorDecorationType || !vscode.workspace.onDidChangeTextDocument)
	{
		return;
	}
	const isPluto = (document) => document.languageId == "pluto";
	/** What is known of each open document: its last text, the functions that have the note, the timer of the removal. */
	const states = new Map();
	const decoration = vscode.window.createTextEditorDecorationType({
		after: { color: new vscode.ThemeColor("editorGhostText.foreground"), fontStyle: "italic", margin: "0 0 0 2em" },
	});
	context.subscriptions.push(decoration);
	let busy = false;

	const stateOf = (document) =>
	{
		const key = document.uri.toString();
		let state = states.get(key);
		if (!state)
		{
			state = { text: document.getText(), flagged: new Set(), timer: null, pending: new Set(), memory: new Set() };
			hint.track(shapesOf(state.text), state.flagged, state.memory);
			states.set(key, state);
		}
		return state;
	};

	const commandArgs = (document, key) => encodeURIComponent(JSON.stringify([document.uri.toString(), key]));

	const hoverFor = (document, shape, text) =>
	{
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = true;
		md.supportHtml = false;
		const valued = shape.returns.filter(r => !r.bare);
		md.appendMarkdown("**" + t("returnHint.code") + "**\n\n");
		for (const r of valued)
		{
			md.appendCodeblock(text.slice(r.start, r.end), "pluto");
		}
		md.appendMarkdown("[" + t("returnHint.goto") + "](command:plua.returnHint.goto?" + commandArgs(document, shape.key) + ")");
		if (valued.length == 1)
		{
			md.appendMarkdown("  |  [" + t("returnHint.remove") + "](command:plua.returnHint.remove?" + commandArgs(document, shape.key) + ")");
		}
		return md;
	};

	const paint = function (editor)
	{
		const document = editor.document;
		if (!isPluto(document))
		{
			return;
		}
		const state = stateOf(document);
		if (!readOptions(document).note)
		{
			editor.setDecorations(decoration, []);
			return;
		}
		const text = document.getText();
		const options = shapesOf(text).filter(s => state.flagged.has(s.key)).map(function (shape)
		{
			const line = document.lineAt(Math.min(shape.closeLine, document.lineCount - 1));
			return {
				range: new vscode.Range(line.range.end, line.range.end),
				hoverMessage: hoverFor(document, shape, text),
				renderOptions: { after: { contentText: hint.describe(shape, text).message } },
			};
		});
		editor.setDecorations(decoration, options);
	};

	const paintAll = () => vscode.window.visibleTextEditors.forEach(paint);

	/** Takes the bare `return` away from the functions that lost their return type, once the colon has stayed away for a while. */
	const removeBare = function (document, keys)
	{
		const state = stateOf(document);
		state.timer = null;
		if (!keys.length || !readOptions(document).autoReturn)
		{
			return;
		}
		const text = document.getText();
		const shapes = shapesOf(text);
		const ranges = [];
		for (const key of keys)
		{
			const s = shapes.find(x => x.key == key);
			if (s && s.onlyBareReturn && ((!s.hasColon && s.retType === null) || hint.isVoid(s.retType)))
			{
				ranges.push(hint.removalRange(text, s.returns[0]));
			}
		}
		if (!ranges.length)
		{
			return;
		}
		busy = true;
		vscode.workspace.applyEdit((function ()
		{
			const edit = new vscode.WorkspaceEdit();
			for (const r of ranges)
			{
				edit.delete(document.uri, new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)));
			}
			return edit;
		})()).then(function () { busy = false; }, function () { busy = false; });
	};

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (!isPluto(document) || event.contentChanges.length == 0)
		{
			return;
		}
		const state = stateOf(document);
		const text = document.getText();
		const after = shapesOf(text);
		state.text = text;
		const result = hint.track(after, state.flagged, state.memory);
		state.flagged = result.flagged;
		if (!busy)
		{
			result.removeBare.forEach(k => state.pending.add(k));
			if (state.pending.size && readOptions(document).autoReturn)
			{
				if (state.timer)
				{
					clearTimeout(state.timer);
				}
				state.timer = setTimeout(function ()
				{
					const keys = [...state.pending];
					state.pending.clear();
					removeBare(document, keys);
				}, REMOVE_DELAY_MS);
			}
		}
		paintAll();
	}));
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(paintAll));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(function (document)
	{
		const state = states.get(document.uri.toString());
		if (state && state.timer)
		{
			clearTimeout(state.timer);
		}
		states.delete(document.uri.toString());
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (event)
	{
		if (event.affectsConfiguration("plua.diagnostics.returnHint"))
		{
			paintAll();
		}
	}));

	// The commands of the links in the hover and of the quick fix.
	const locate = function (uriText, key)
	{
		const document = vscode.workspace.textDocuments.find(d => d.uri.toString() == uriText);
		const shape = document ? shapesOf(document.getText()).find(s => s.key == key) : null;
		return document && shape ? { document, shape, text: document.getText() } : null;
	};
	context.subscriptions.push(vscode.commands.registerCommand("plua.returnHint.goto", async function (uriText, key)
	{
		const found = locate(uriText, key);
		const first = found && found.shape.returns.find(r => !r.bare);
		if (!first)
		{
			return;
		}
		const editor = await vscode.window.showTextDocument(found.document);
		const range = new vscode.Range(found.document.positionAt(first.start), found.document.positionAt(first.end));
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}));
	context.subscriptions.push(vscode.commands.registerCommand("plua.returnHint.remove", async function (uriText, key)
	{
		const found = locate(uriText, key);
		const valued = found ? found.shape.returns.filter(r => !r.bare) : [];
		if (valued.length != 1)
		{
			return;
		}
		const r = hint.removalRange(found.text, valued[0]);
		const edit = new vscode.WorkspaceEdit();
		edit.delete(found.document.uri, new vscode.Range(found.document.positionAt(r.start), found.document.positionAt(r.end)));
		await vscode.workspace.applyEdit(edit);
	}));

	// The quick fix on the header of the function and on its `return`.
	if (vscode.languages.registerCodeActionsProvider)
	{
		context.subscriptions.push(vscode.languages.registerCodeActionsProvider([{ language: "pluto" }], {
			provideCodeActions(document, range)
			{
				const state = states.get(document.uri.toString());
				if (!state || !state.flagged.size || !readOptions(document).note)
				{
					return [];
				}
				const out = [];
				for (const shape of shapesOf(document.getText()))
				{
					const valued = shape.returns.filter(r => !r.bare);
					if (!state.flagged.has(shape.key) || valued.length != 1)
					{
						continue;
					}
					const first = valued[0].line;
					if ((range.start.line <= shape.closeLine && range.end.line >= shape.closeLine) || (range.start.line <= first && range.end.line >= first))
					{
						const action = new vscode.CodeAction(t("returnHint.remove"), vscode.CodeActionKind.QuickFix);
						action.command = { command: "plua.returnHint.remove", title: t("returnHint.remove"), arguments: [document.uri.toString(), shape.key] };
						out.push(action);
					}
				}
				return out;
			},
		}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
	}
}

module.exports = { registerReturnHint, readOptions };
