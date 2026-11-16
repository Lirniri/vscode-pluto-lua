// Editor behavior around type hints in Pluto files: the list of types opens by itself while a type
// hint is being typed, and nullable types (`int?`, `?string`, `Vehicle?`) are highlighted.

"use strict";

const vscode = require("vscode");
const { isTypeHintPosition, findNullableTypes } = require("./typeHints");

const MAX_HIGHLIGHT_LENGTH = 1024 * 1024;

/**
 * Opens the suggestion list when `:` (or a space after it) is typed where a type hint goes:
 * `function f(a: |`, `function f(): |`, `local x: |`. Method calls (`obj:method`) are left alone.
 * Only for Pluto files, never for `.lua`.
 * @param {vscode.TextDocumentChangeEvent} event
 * @returns {boolean} Whether the list was requested.
 */
function triggerTypeSuggest(event)
{
	const document = event.document;
	if (document.languageId !== "pluto" || event.contentChanges.length != 1)
	{
		return false;
	}
	const change = event.contentChanges[0];
	if (change.rangeLength != 0 || (change.text != ":" && change.text != " " && change.text != ": "))
	{
		return false;
	}
	if (event.reason == vscode.TextDocumentChangeReason.Undo || event.reason == vscode.TextDocumentChangeReason.Redo)
	{
		return false;
	}
	if (!vscode.workspace.getConfiguration("plua", document.uri).get("completion.autoTriggerTypes", true))
	{
		return false;
	}
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document !== document || editor.selections.length != 1)
	{
		return false;
	}
	// The cursor must be right behind what was typed.
	const cursor = editor.selection.active;
	if (cursor.line != change.range.start.line || cursor.character != change.range.start.character + change.text.length)
	{
		return false;
	}
	if (!isTypeHintPosition(document.lineAt(cursor.line).text.slice(0, cursor.character)))
	{
		return false;
	}
	vscode.commands.executeCommand("editor.action.triggerSuggest");
	return true;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function registerTypeAutoTrigger(context)
{
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(triggerTypeSuggest));
}

/**
 * Colors nullable types in Pluto files. The color is a decoration, so it is applied on top of
 * whatever the theme does with type hints.
 */
class NullableHighlighter
{
	constructor()
	{
		this.type = null;
		this._timers = new Map();
		this.rebuild();
	}

	_settings()
	{
		const config = vscode.workspace.getConfiguration("plua");
		const color = (key, fallback) => String(config.get(key, fallback) || fallback);
		return {
			enabled: config.get("highlight.nullableTypes", true) !== false,
			color: color("highlight.nullableTypeColor", "#FFFFFF"),
			lightColor: color("highlight.nullableTypeLightColor", "#000000"),
		};
	}

	/** (Re)creates the decoration type from the settings and applies it to the visible editors. */
	rebuild()
	{
		if (this.type)
		{
			this.type.dispose();
			this.type = null;
		}
		const settings = this._settings();
		if (settings.enabled)
		{
			// White is invisible on light themes, which therefore get their own color.
			this.type = vscode.window.createTextEditorDecorationType({
				color: settings.color,
				dark: { color: settings.color },
				light: { color: settings.lightColor },
			});
		}
		this.applyAll();
	}

	applyAll()
	{
		for (const editor of vscode.window.visibleTextEditors || [])
		{
			this.apply(editor);
		}
	}

	/** @param {vscode.TextEditor} editor */
	apply(editor)
	{
		if (!this.type || editor.document.languageId !== "pluto")
		{
			return;
		}
		const text = editor.document.getText();
		const ranges = text.length > MAX_HIGHLIGHT_LENGTH ? [] : findNullableTypes(text).map(r => new vscode.Range(r.line, r.col, r.line, r.endCol));
		editor.setDecorations(this.type, ranges);
	}

	/** Re-applies the highlight to the editors of a document after it was edited. */
	schedule(document)
	{
		if (document.languageId !== "pluto")
		{
			return;
		}
		const key = document.uri.toString();
		clearTimeout(this._timers.get(key));
		this._timers.set(key, setTimeout(() =>
		{
			this._timers.delete(key);
			for (const editor of vscode.window.visibleTextEditors || [])
			{
				if (editor.document === document)
				{
					this.apply(editor);
				}
			}
		}, 150));
	}

	dispose()
	{
		for (const timer of this._timers.values())
		{
			clearTimeout(timer);
		}
		this._timers.clear();
		if (this.type)
		{
			this.type.dispose();
			this.type = null;
		}
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @returns {NullableHighlighter}
 */
function registerNullableHighlight(context)
{
	const highlighter = new NullableHighlighter();
	context.subscriptions.push(
		highlighter,
		vscode.window.onDidChangeVisibleTextEditors(() => highlighter.applyAll()),
		vscode.window.onDidChangeActiveTextEditor(editor => editor && highlighter.apply(editor)),
		vscode.workspace.onDidChangeTextDocument(event => event.contentChanges.length && highlighter.schedule(event.document)),
		vscode.workspace.onDidChangeConfiguration(function (event)
		{
			if (event.affectsConfiguration("plua.highlight"))
			{
				highlighter.rebuild();
			}
		})
	);
	return highlighter;
}

module.exports = { triggerTypeSuggest, registerTypeAutoTrigger, NullableHighlighter, registerNullableHighlight };
