// The part of the auto indent that lives in the editor: Enter handling and the cleaning of empty lines on save.
// The rules are in ./autoIndent.

"use strict";

const vscode = require("vscode");
const indent = require("./autoIndent");

function readOptions(document)
{
	const config = vscode.workspace.getConfiguration("plua", document ? document.uri : undefined);
	return {
		enabled: config.get("autoIndent.enabled", true) !== false,
		preserveEmptyLines: config.get("autoIndent.preserveEmptyLines", true) !== false,
		indentAfterCase: config.get("autoIndent.indentAfterCase", true) !== false,
		trimOnSave: config.get("autoIndent.trimOnSave", false) === true,
	};
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerAutoIndent(context, service)
{
	const applies = (document) => document.languageId == "pluto" || (document.languageId == "lua" && service.luaEnabled());
	let busy = false;
	/** The line where Enter was just handled: the editor may take its indentation away a moment later (trimAutoWhitespace). */
	let recent = null;

	const fix = function (editor, line)
	{
		const document = editor.document;
		const options = readOptions(document);
		const lineAt = (i) => (i >= 0 && i < document.lineCount ? document.lineAt(i).text : undefined);
		const edits = indent.planEnter(lineAt, line, { insertSpaces: editor.options.insertSpaces, tabSize: editor.options.tabSize }, options);
		if (!edits.length)
		{
			return;
		}
		const cursorOnNext = editor.selections.length == 1 && editor.selection.isEmpty && editor.selection.active.line == line + 1;
		busy = true;
		// No undo stops around it: one Ctrl+Z takes back the Enter together with the indentation.
		editor.edit(function (builder)
		{
			for (const e of edits)
			{
				builder.replace(document.lineAt(e.line).range, e.text);
			}
		}, { undoStopBefore: false, undoStopAfter: false }).then(function ()
		{
			busy = false;
			if (cursorOnNext)
			{
				const end = document.lineAt(line + 1).range.end;
				editor.selection = new vscode.Selection(end, end);
			}
		}, function ()
		{
			busy = false;
		});
	};

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (busy || !applies(document) || event.contentChanges.length < 1 || event.contentChanges.length > 2)
		{
			return;
		}
		const reasons = vscode.TextDocumentChangeReason;
		if (reasons && (event.reason === reasons.Undo || event.reason === reasons.Redo))
		{
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== document || editor.selections.length != 1)
		{
			return;
		}
		const last = event.contentChanges[event.contentChanges.length - 1];
		const enter = event.contentChanges.find(c => c.rangeLength == 0 && indent.ENTER.test(c.text));
		if (enter)
		{
			recent = { uri: document.uri.toString(), line: enter.range.start.line, at: Date.now() };
			fix(editor, enter.range.start.line);
			return;
		}
		// The editor cut the indentation off the line that was left empty, as a change of its own.
		if (recent && last.text === "" && last.rangeLength > 0 && recent.uri == document.uri.toString()
			&& last.range.start.line == recent.line && Date.now() - recent.at < 300)
		{
			fix(editor, recent.line);
		}
	}));

	// Optional: no whitespace on empty lines in the file on disk.
	if (vscode.workspace.onWillSaveTextDocument)
	{
		context.subscriptions.push(vscode.workspace.onWillSaveTextDocument(function (event)
		{
			const document = event.document;
			if (!applies(document) || !readOptions(document).trimOnSave)
			{
				return;
			}
			const lineAt = (i) => document.lineAt(i).text;
			const edits = indent.whitespaceOnlyLines(lineAt, document.lineCount)
				.map(l => vscode.TextEdit.delete(new vscode.Range(l.line, 0, l.line, l.length)));
			event.waitUntil(Promise.resolve(edits));
		}));
	}
}

module.exports = { registerAutoIndent, readOptions };
