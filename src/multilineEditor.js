// Editor side of the smart formatting of multi-line parameter lists and tables, see ./multilineFormat.

"use strict";

const vscode = require("vscode");
const { planEnter, planFirstElement } = require("./multilineFormat");

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
 * Wires the formatting to typing in Pluto files, and in Lua files while the Lua support is on.
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerMultilineFormat(context, service)
{
	let busy = false;
	const applies = (document) => document.languageId == "pluto" || (document.languageId == "lua" && service.luaEnabled());

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (busy || event.contentChanges.length != 1 || !applies(document))
		{
			return;
		}
		if (event.reason == vscode.TextDocumentChangeReason.Undo || event.reason == vscode.TextDocumentChangeReason.Redo)
		{
			return;
		}
		const config = vscode.workspace.getConfiguration("pluto", document.uri);
		const options = {
			params: config.get("format.multilineParams", true) !== false,
			tables: config.get("format.multilineTables", true) !== false,
		};
		if (!options.params && !options.tables)
		{
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== document || editor.selections.length != 1)
		{
			return;
		}
		const change = event.contentChanges[0];
		const eol = document.eol == vscode.EndOfLine.CRLF ? "\r\n" : "\n";
		let plan = null;
		try
		{
			if (change.rangeLength == 0 && /^\r?\n[ \t]*$/.test(change.text))
			{
				// Enter: the comma at the end of the element above the new line.
				plan = planEnter(document.getText(), change.range.start.line, options);
			}
			else if (change.text && !/[\r\n]/.test(change.text))
			{
				// Typing: the first element of an empty multi-line list goes to its own line.
				// The selection is not updated yet when the change is reported: the cursor is where the text ends.
				const line = change.range.start.line;
				const col = change.range.start.character + change.text.length;
				plan = planFirstElement(document.getText(), line, col, options, indentUnit(editor), eol);
			}
		}
		catch (e)
		{
			console.error("Pluto: formatting failed", e);
			return;
		}
		if (!plan)
		{
			return;
		}
		busy = true;
		editor.edit(function (builder)
		{
			for (const e of plan.edits)
			{
				builder.replace(new vscode.Range(e.line, e.col, e.endLine, e.endCol), e.text);
			}
		}, { undoStopBefore: false, undoStopAfter: false }).then(function ()
		{
			// The edit may have moved the cursor (and VS Code wipes the indentation of a line the cursor left): put it back.
			const pos = new vscode.Position(plan.cursor.line, plan.cursor.col);
			editor.selection = new vscode.Selection(pos, pos);
			busy = false;
		}, function ()
		{
			busy = false;
		});
	}));
}

module.exports = { registerMultilineFormat };
