// Select the name of a class and the classes that extend it, directly or down the chain of `extends`, show up in a peek
// window (the one of Peek Definition) when they are out of sight. What is on the screen is marked by the editor
// itself, the way it marks every occurrence of the selected word.

"use strict";

const vscode = require("vscode");
const { selectedName, outOfSight } = require("./heirsPeek");

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerHeirsPeek(context, service)
{
	let timer = null;
	/** The selection the window was opened for, and whether it is still up. */
	let shown = null;
	const closeOwn = function ()
	{
		if (shown)
		{
			shown = null;
			vscode.commands.executeCommand("closeReferenceSearch");
		}
	};

	const show = async function (editor, expected)
	{
		const document = editor.document;
		const selection = editor.selection;
		// the selection is not the one that was waited for: the user went on
		if (editor !== vscode.window.activeTextEditor || selection.isEmpty || !selection.isSingleLine || !selection.isEqual(expected))
		{
			return;
		}
		const config = vscode.workspace.getConfiguration("plua", document.uri);
		if (!config.get("heirsPeek", true))
		{
			return;
		}
		const name = selectedName(document.lineAt(selection.start.line).text, selection.start.character, selection.end.character);
		if (!name)
		{
			return;
		}
		service.getRecord(document);
		if (!service.index.classes(name).length)
		{
			return;
		}
		const heirs = service.index.subclasses(name)
			.map(h => ({ key: h.file.key, line: h.sym.line, col: h.sym.col, depth: h.depth }))
			.sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.line - b.line));
		const far = outOfSight(heirs, document.uri.toString(), editor.visibleRanges.map(r => ({ start: r.start.line, end: r.end.line })));
		if (!far.length)
		{
			return;
		}
		const locations = far.map(h => new vscode.Location(vscode.Uri.parse(h.key, true), new vscode.Position(h.line, h.col)));
		shown = selection;
		await vscode.commands.executeCommand("editor.action.peekLocations", document.uri, selection.start, locations, "peek");
	};

	context.subscriptions.push(
		{ dispose() { clearTimeout(timer); } },
		vscode.window.onDidChangeTextEditorSelection(function (event)
		{
			const editor = event.textEditor;
			// The editor inside of a peek window (it has no view column) reports its selections too: they are not the user's.
			if (editor.viewColumn === undefined)
			{
				return;
			}
			clearTimeout(timer);
			// The window itself puts the cursor at the start of the word it was opened for: that is no reason to close it.
			if (shown && !(editor.selections.length == 1 && (editor.selection.isEqual(shown) || (editor.selection.isEmpty && editor.selection.active.isEqual(shown.start)))))
			{
				closeOwn();
			}
			if (editor.document.languageId != "pluto" || editor.selections.length != 1 || editor.selection.isEmpty)
			{
				return;
			}
			const expected = editor.selection;
			const delay = Math.max(0, Number(vscode.workspace.getConfiguration("plua", editor.document.uri).get("heirsPeekDelayMs", 400)) || 0);
			timer = setTimeout(() => { show(editor, expected).catch(() => { }); }, delay);
		}),
		vscode.window.onDidChangeActiveTextEditor(function ()
		{
			clearTimeout(timer);
			closeOwn();
		})
	);
}

module.exports = { registerHeirsPeek };
