// The part of the layout fixer that lives in the editor: the typing listener and the `plua.convertLayout` command.
// The rules are in ./layoutFixer.

"use strict";

const vscode = require("vscode");
const fixer = require("./layoutFixer");
const { t } = require("./i18n");

/** The options of the fixer from the settings. */
function readOptions(document)
{
	const config = vscode.workspace.getConfiguration("plua", document ? document.uri : undefined);
	return {
		enabled: config.get("layoutFixer.enabled", true) !== false,
		mode: fixer.MODES.includes(config.get("layoutFixer.mode", "live")) ? config.get("layoutFixer.mode", "live") : "live",
		sourceLayouts: config.get("layoutFixer.sourceLayouts", ["ru"]),
		baseKeyboardProfile: config.get("layoutFixer.baseKeyboardProfile", "physicalQwerty"),
		ignoreComments: config.get("layoutFixer.ignoreComments", true) !== false,
		ignoreStrings: config.get("layoutFixer.ignoreStrings", true) !== false,
		autoCloseCyrillicQuotes: config.get("layoutFixer.autoCloseCyrillicQuotes", true) !== false,
		customMap: config.get("layoutFixer.customMap", {}),
	};
}

/**
 * What a change of the document asks for: the edit that fixes the typed text, or `null`. Undo and redo are never
 * touched, so Ctrl+Z gives back what was typed instead of converting it again.
 * @param {string} text The document after the change.
 * @param {{ rangeLength: number, text: string }} change
 * @param {number} offset Where the change starts.
 * @param {any} reason The change reason (`vscode.TextDocumentChangeReason`).
 * @param {any} options `readOptions`
 */
function planChange(text, change, offset, reason, options)
{
	const reasons = vscode.TextDocumentChangeReason;
	if (!options.enabled || options.mode == "off" || change.text.length == 0)
	{
		return null;
	}
	if (reasons && (reason === reasons.Undo || reason === reasons.Redo))
	{
		return null;
	}
	const layout = fixer.buildLayout(options);
	if (change.text.length == 1 && layout.map.has(change.text))
	{
		return fixer.liveChange(text, offset, layout, options);
	}
	if (options.mode != "live" && fixer.isDelimiter(change.text))
	{
		return fixer.wordChange(text, offset, layout, options);
	}
	return null;
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerLayoutFixer(context, service)
{
	const applies = (document) => document.languageId == "pluto" || (document.languageId == "lua" && service.luaEnabled());
	let busy = false;

	/**
	 * Puts the conversion in. It is not held back by other typing: keys that come while it is on its way are converted on
	 * their own. When the editor turns the edit down because the text changed in the meantime, the plan is made again.
	 */
	const apply = function (editor, document, change, offset, attempt)
	{
		const text = document.getText();
		// The typed text is still where it was typed (what comes after it does not matter).
		if (text.slice(offset, offset + change.text.length) != change.text)
		{
			return;
		}
		const edit = planChange(text, change, offset, undefined, readOptions(document));
		if (!edit)
		{
			return;
		}
		const delta = edit.text.length - (edit.end - edit.start);
		// The cursor, as it is when the edit comes: a replacement of the same length leaves it where it is.
		const caretBefore = editor.selections.length == 1 && editor.selection.isEmpty ? document.offsetAt(editor.selection.active) : -1;
		// No undo stop on either side: one Ctrl+Z takes back both the typed key and its conversion.
		editor.edit(function (builder)
		{
			builder.replace(new vscode.Range(document.positionAt(edit.start), document.positionAt(edit.end)), edit.text);
		}, { undoStopBefore: false, undoStopAfter: false }).then(function (applied)
		{
			if (!applied)
			{
				if (attempt < 4)
				{
					setTimeout(() => apply(editor, document, change, offset, attempt + 1), 15);
				}
				return;
			}
			if (delta != 0 && caretBefore >= edit.end && editor.selections.length == 1 && editor.selection.isEmpty
				&& document.offsetAt(editor.selection.active) == caretBefore)
			{
				const pos = document.positionAt(caretBefore + delta);
				editor.selection = new vscode.Selection(pos, pos);
			}
		}, function () { });
	};

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (!applies(document) || event.contentChanges.length != 1)
		{
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document !== document || editor.selections.length != 1)
		{
			return;
		}
		const change = event.contentChanges[0];
		const options = readOptions(document);
		const offset = document.offsetAt(change.range.start);
		// Is there anything to do? (The plan is made again when it is carried out.)
		if (!planChange(document.getText(), change, offset, event.reason, options))
		{
			return;
		}
		apply(editor, document, change, offset, 0);
	}));

	// The manual conversion: the selections, or the line of the cursor when nothing is selected.
	context.subscriptions.push(vscode.commands.registerCommand("plua.convertLayout", async function ()
	{
		const editor = vscode.window.activeTextEditor;
		if (!editor)
		{
			return;
		}
		const document = editor.document;
		const options = readOptions(document);
		const layout = fixer.buildLayout(options);
		const text = document.getText();
		const edits = [];
		for (const selection of editor.selections)
		{
			const range = selection.isEmpty ? document.lineAt(selection.active.line).range : selection;
			edits.push(...fixer.convertRange(text, document.offsetAt(range.start), document.offsetAt(range.end), layout, options));
		}
		const unique = edits.filter((e, i) => edits.findIndex(o => o.start == e.start) == i);
		if (!unique.length)
		{
			vscode.window.showInformationMessage(t("layout.nothing"));
			return;
		}
		busy = true;
		try
		{
			await editor.edit(function (builder)
			{
				for (const e of unique)
				{
					builder.replace(new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)), e.text);
				}
			});
		}
		finally
		{
			busy = false;
		}
	}));
}

module.exports = { registerLayoutFixer, planChange, readOptions };
