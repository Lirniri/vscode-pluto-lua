// Editor side of the hints for parameters without a default value: a yellow wavy line under the type of the
// parameter the cursor is on (with a tooltip), and the list of values opened by itself when the cursor rests.
// See ./defaultValues for what is a parameter and which values fit its type.

"use strict";

const vscode = require("vscode");
const { paramAt, isCompleteType, defaultValuesFor } = require("./defaultValues");
const { untypedParamAt, caseNoColonAt } = require("./hints");
const { t } = require("./i18n");

/**
 * Whether a name is a class or an enum that is visible at a line.
 * @param {import("./extension").LanguageService} service
 * @param {vscode.TextDocument} document
 * @param {number} line
 * @returns {(name: string) => boolean}
 */
function classChecker(service, document, line)
{
	const names = new Set();
	const file = service.getRecord(document);
	for (const sym of [...service.analyzer.visibleLocals(file, line).values(), ...service.index.globals()])
	{
		if ((sym.kind == "class" || sym.kind == "enum") && !sym.container)
		{
			names.add(sym.name);
		}
	}
	return (name) => names.has(name);
}

class DefaultValueHint
{
	/**
	 * @param {import("./extension").LanguageService} service
	 */
	constructor(service)
	{
		this.service = service;
		this.type = null;
		this._timer = null;
		this._firedFor = "";
		this.rebuild();
	}

	_settings()
	{
		const config = vscode.workspace.getConfiguration("pluto");
		const color = (key, fallback) => String(config.get(key, fallback) || fallback);
		return {
			highlight: config.get("highlight.paramNoDefault", true) !== false,
			color: color("highlight.paramNoDefaultColor", "#E5C07B"),
			lightColor: color("highlight.paramNoDefaultLightColor", "#BF8803"),
			paramNoType: config.get("highlight.paramNoType", true) !== false,
			caseNoColon: config.get("highlight.caseNoColon", true) !== false,
			values: config.get("completion.defaultValues", true) !== false,
			delayMs: Math.max(0, Number(config.get("completion.defaultValuesDelayMs", 800)) || 0),
		};
	}

	/** (Re)creates the decoration from the settings and shows the hint in the visible editors. */
	rebuild()
	{
		if (this.type)
		{
			this.type.dispose();
			this.type = null;
		}
		if (this.missingType)
		{
			this.missingType.dispose();
			this.missingType = null;
		}
		const settings = this._settings();
		const line = (color) => ({ textDecoration: "underline wavy " + color });
		this.type = vscode.window.createTextEditorDecorationType(Object.assign(line(settings.color), {
			dark: line(settings.color),
			light: line(settings.lightColor),
		}));
		// The same line for what is missing: the type of a parameter, the colon of a `case`.
		this.missingType = vscode.window.createTextEditorDecorationType(Object.assign(line(settings.color), {
			dark: line(settings.color),
			light: line(settings.lightColor),
		}));
		for (const editor of vscode.window.visibleTextEditors || [])
		{
			this.update(editor);
		}
	}

	/**
	 * The parameter under the cursor that has a complete type and no default value.
	 * @param {vscode.TextEditor} editor
	 */
	infoAt(editor)
	{
		const document = editor.document;
		if (document.languageId != "pluto" || editor.selections.length != 1 || !editor.selection.isEmpty)
		{
			return null;
		}
		const offset = document.offsetAt(editor.selection.active);
		const info = paramAt(document.getText(), offset);
		if (!info || info.hasDefault)
		{
			return null;
		}
		const isClass = classChecker(this.service, document, info.line);
		if (!isCompleteType(info.typeText, isClass))
		{
			return null;
		}
		return { info, offset, values: defaultValuesFor(info.typeText, isClass), document };
	}

	/** Shows the ranges of the hint in an editor (a seam for tests). */
	_decorate(editor, ranges)
	{
		editor.setDecorations(this.type, ranges);
	}

	/** Shows the ranges of the hints for what is missing (a seam for tests). */
	_decorateMissing(editor, ranges)
	{
		editor.setDecorations(this.missingType, ranges);
	}

	/** The yellow line under a parameter that has no type, and under a `case` that has no colon, while the cursor is on it. */
	updateMissing(editor)
	{
		if (!this.missingType)
		{
			return;
		}
		const settings = this._settings();
		const ranges = [];
		const document = editor.document;
		if (document.languageId == "pluto" && editor.selections.length == 1 && editor.selection.isEmpty && (settings.paramNoType || settings.caseNoColon))
		{
			const text = document.getText();
			const offset = document.offsetAt(editor.selection.active);
			const md = (message) => { const m = new vscode.MarkdownString(); m.appendMarkdown(message); return m; };
			const param = settings.paramNoType ? untypedParamAt(text, offset) : null;
			if (param)
			{
				ranges.push({ range: new vscode.Range(document.positionAt(param.nameStart), document.positionAt(param.nameEnd)), hoverMessage: md(t("missing.paramType", param.name)) });
			}
			const missingCase = settings.caseNoColon ? caseNoColonAt(text, offset) : null;
			if (missingCase)
			{
				ranges.push({ range: new vscode.Range(missingCase.line, missingCase.col, missingCase.line, missingCase.endCol), hoverMessage: md(t("missing.caseColon")) });
			}
		}
		this._decorateMissing(editor, ranges);
	}

	/** Opens the list of suggestions (a seam for tests). */
	_triggerSuggest()
	{
		return vscode.commands.executeCommand("editor.action.triggerSuggest");
	}

	/**
	 * Shows or hides the hint for the cursor of an editor, and arms the timer that opens the list of values.
	 * @param {vscode.TextEditor} editor
	 */
	update(editor)
	{
		clearTimeout(this._timer);
		if (!this.type || !editor || editor.document.languageId != "pluto")
		{
			return;
		}
		this.updateMissing(editor);
		const settings = this._settings();
		const found = settings.highlight || (settings.values && settings.delayMs > 0) ? this.infoAt(editor) : null;
		if (!found || !settings.highlight)
		{
			this._decorate(editor, []);
		}
		if (!found)
		{
			return;
		}
		const { info, offset, values, document } = found;
		if (settings.highlight)
		{
			const hint = new vscode.MarkdownString();
			hint.appendMarkdown(values.length
				? t("defaultValue.hint", info.name, values.slice(0, 3).map(v => "`= " + v + "`").join(", "))
				: t("defaultValue.hintNone", info.name));
			this._decorate(editor, [{
				range: new vscode.Range(document.positionAt(info.typeStart), document.positionAt(info.typeEnd)),
				hoverMessage: hint,
			}]);
		}
		// The cursor rests right after the type: open the list of values by itself, once for this place.
		const rest = document.getText().slice(info.typeEnd, offset);
		if (settings.values && settings.delayMs > 0 && values.length && offset >= info.typeEnd && rest.trim() == "")
		{
			const key = document.uri.toString() + "|" + document.version + "|" + offset;
			this._timer = setTimeout(() =>
			{
				const current = vscode.window.activeTextEditor;
				if (key == this._firedFor || current !== editor || document.version != Number(key.split("|")[1])
					|| document.offsetAt(editor.selection.active) != offset)
				{
					return;
				}
				this._firedFor = key;
				this._triggerSuggest();
			}, settings.delayMs);
		}
	}

	dispose()
	{
		clearTimeout(this._timer);
		if (this.type)
		{
			this.type.dispose();
		}
		if (this.missingType)
		{
			this.missingType.dispose();
		}
	}
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 * @returns {DefaultValueHint}
 */
function registerDefaultValueHint(context, service)
{
	const hint = new DefaultValueHint(service);
	context.subscriptions.push(
		hint,
		vscode.window.onDidChangeTextEditorSelection(event => hint.update(event.textEditor)),
		vscode.window.onDidChangeActiveTextEditor(editor => editor && hint.update(editor)),
		vscode.workspace.onDidChangeTextDocument(function (event)
		{
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document === event.document && event.contentChanges.length)
			{
				hint.update(editor);
			}
		}),
		vscode.workspace.onDidChangeConfiguration(function (event)
		{
			if (event.affectsConfiguration("pluto.highlight") || event.affectsConfiguration("pluto.completion"))
			{
				hint.rebuild();
			}
		})
	);
	return hint;
}

module.exports = { registerDefaultValueHint, DefaultValueHint, classChecker };
