// The part of the return hint that lives in the editor: it watches the functions of the open Pluto files, removes a bare
// `return` when the return type of its function was taken away, shows the grey note for a `return` with a value (with a hover that
// has the code and the offer to remove it) and the quick fix. The rules are in ./returnHint.

"use strict";

const vscode = require("vscode");
const { findFunctionShapes } = require("./hints");
const hint = require("./returnHint");
const { createIdleController } = require("./idleController");
const { t } = require("./i18n");
const { PRIMITIVE_TYPES } = require("./analysis");

const REMOVE_DELAY_MS = 600;
const DIRECTIVE_DELAY_MS = 700;

/** Set while the module is registered: arms the idle move of the cursor for the empty line that was just made. */
let armIdle = function () { };

function readOptions(document)
{
	const config = vscode.workspace.getConfiguration("plua", document ? document.uri : undefined);
	return {
		autoReturn: config.get("format.autoReturn", true) !== false,
		note: config.get("diagnostics.returnHint", true) !== false,
		removeReturn: config.get("returnHelper.removeReturnWhenTypeMissing", true) !== false,
		idleMove: config.get("returnHelper.moveCursorToReturnOnIdle", true) !== false,
		idleDelayMs: Math.max(200, Number(config.get("returnHelper.idleDelayMs", 2000)) || 2000),
		// the live directives carry `#return = ...` out when they are on
		directive: config.get("returnHelper.enableReturnDirective", true) !== false && config.get("liveDirectives.enabled", true) === false,
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
 * @param {import("./extension").LanguageService} [service]
 */
function registerReturnHint(context, service)
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
	/** Whether a type name is built in or a class or enum that the index knows. */
	const isKnown = (name) => PRIMITIVE_TYPES.has(name)
		|| !!(service && service.analyzer && service.analyzer.index.lookup(name).some(sym => sym.kind == "class" || sym.kind == "enum"));

	const stateOf = (document) =>
	{
		const key = document.uri.toString();
		let state = states.get(key);
		if (!state)
		{
			state = { text: document.getText(), flagged: new Set(), timer: null, dirTimer: null, pending: new Set(), pendingVoid: new Set(), memory: new Set(), suppressed: new Set() };
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
	const removeBare = function (document, keys, voidKeys)
	{
		const state = stateOf(document);
		state.timer = null;
		if (!keys.length || !readOptions(document).removeReturn)
		{
			return;
		}
		const text = document.getText();
		const shapes = shapesOf(text);
		const ranges = [];
		for (const key of keys)
		{
			const s = shapes.find(x => x.key == key);
			// `void` only counts when the type was just changed to it; any other type has to be a usable one.
			if (s && s.onlyBareReturn && (hint.isVoid(s.retType) ? voidKeys.includes(key) : !hint.typeIsValid(s.retType, isKnown)))
			{
				ranges.push(hint.removalRange(text, s.returns[0]));
				state.suppressed.add(key); // Ctrl+Z brings the return back and it stays
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

	/** `#return = <expression>`: the line goes, the expression becomes the `return` at the end of the function. */
	const runDirective = function (document)
	{
		const state = stateOf(document);
		state.dirTimer = null;
		if (!readOptions(document).directive)
		{
			return;
		}
		const text = document.getText();
		const dirs = hint.findDirectives(text);
		const editor = vscode.window.visibleTextEditors.find(e => e.document === document);
		const options = editor ? editor.options : {};
		const unit = options.insertSpaces === false ? "\t" : " ".repeat(Number(options.tabSize) || 4);
		const eol = document.eol == vscode.EndOfLine.CRLF ? String.fromCharCode(13, 10) : String.fromCharCode(10);
		for (const dir of dirs)
		{
			const next = hint.applyDirective(text.split(String.fromCharCode(13)).join(""), dir, unit, String.fromCharCode(10));
			if (next === null)
			{
				continue;
			}
			// Positions are those of the text with LF breaks; on a CRLF document they are put back.
			const plain = text.split(String.fromCharCode(13)).join("");
			const change = hint.minimalEdit(plain, next);
			const toOffset = (n) => (eol.length == 2 ? n + plain.slice(0, n).split(String.fromCharCode(10)).length - 1 : n);
			busy = true;
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(document.positionAt(toOffset(change.start)), document.positionAt(toOffset(change.end))), eol.length == 2 ? change.text.split(String.fromCharCode(10)).join(eol) : change.text);
			vscode.workspace.applyEdit(edit).then(function () { busy = false; }, function () { busy = false; });
			return;
		}
	};

	// After the `return ` line was made below the empty line of the cursor: when the cursor rests there, the empty line goes and
	// the cursor moves behind `return `. The timer stands still while a list of suggestions or the parameter hints are open.
	const fireIdle = function (here)
	{
		const editor = vscode.window.activeTextEditor;
		if (!here || !editor || editor.document !== here.document || editor.selections.length != 1 || !editor.selection.isEmpty)
		{
			return;
		}
		const document = here.document;
		const line = here.line;
		if (editor.selection.active.line != line || line < 1 || line + 1 >= document.lineCount
			|| document.lineAt(line).text.trim() != "" || document.lineAt(line + 1).text.trim() != "return")
		{
			return;
		}
		busy = true;
		const edit = new vscode.WorkspaceEdit();
		edit.delete(document.uri, new vscode.Range(document.lineAt(line - 1).range.end, document.lineAt(line).range.end));
		vscode.workspace.applyEdit(edit).then(function ()
		{
			busy = false;
			const target = document.lineAt(line); // the `return` line has moved up
			const spaced = target.text.endsWith(" ") ? target.text : target.text + " ";
			const finish = () => { const end = document.lineAt(line).range.end; editor.selection = new vscode.Selection(end, end); };
			if (spaced != target.text)
			{
				editor.edit(b => b.insert(target.range.end, " ")).then(finish, finish);
			}
			else
			{
				finish();
			}
		}, function () { busy = false; });
	};
	const idleCtl = createIdleController({
		delay: () => { const d = idleCtl.data; return Math.max(200, d ? readOptions(d.document).idleDelayMs : 2000); },
		onFire: fireIdle,
		onContext: (armed) => { vscode.commands.executeCommand("setContext", "plua.idleArmed", armed); },
	});
	const cancelIdle = () => idleCtl.cancel();
	armIdle = function (document, line)
	{
		if (!isPluto(document) || !readOptions(document).idleMove)
		{
			return;
		}
		idleCtl.arm({ document, line });
	};
	context.subscriptions.push({ dispose: () => { idleCtl.cancel(); armIdle = () => { }; } });
	// Keys that open or use the list of suggestions / the parameter hints hold the timer, the ones that close them release it
	// (see the keybindings of `plua.idle.key`).
	context.subscriptions.push(vscode.commands.registerCommand("plua.idle.key", async function (command, mode)
	{
		if (mode == "hold")
		{
			idleCtl.hold(); // before the list opens: the timer must not fire in between
		}
		if (typeof command == "string")
		{
			await vscode.commands.executeCommand(command);
		}
		if (mode == "release")
		{
			idleCtl.release();
		}
	}));
	if (vscode.window.onDidChangeTextEditorSelection)
	{
		context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(function (event)
		{
			const here = idleCtl.data;
			if (here && event.textEditor.document === here.document)
			{
				if (event.selections.length != 1 || event.selections[0].active.line != here.line)
				{
					idleCtl.cancel();
				}
				else
				{
					idleCtl.touch(); // not while the list is open
				}
			}
		}));
	}

	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(function (event)
	{
		const document = event.document;
		if (!isPluto(document) || event.contentChanges.length == 0)
		{
			return;
		}
		const resting = idleCtl.data;
		if (resting && resting.document === document && !busy)
		{
			cancelIdle(); // something was typed
		}
		const state = stateOf(document);
		const text = document.getText();
		const after = shapesOf(text);
		state.text = text;
		const result = hint.track(after, state.flagged, state.memory);
		state.flagged = result.flagged;
		const reasons = vscode.TextDocumentChangeReason;
		const undoing = reasons && (event.reason === reasons.Undo || event.reason === reasons.Redo);
		if (!busy)
		{
			const options = readOptions(document);
			const lines = event.contentChanges.map(c => c.range.start.line);
			const touched = after.filter(s => lines.some(l => l >= s.closeLine && l <= s.endLine)).map(s => s.key);
			if (!undoing)
			{
				touched.forEach(k => state.suppressed.delete(k)); // an edit of the user ends the protection from the undo
			}
			if (options.removeReturn)
			{
				// Ctrl+Z that erased the value of a return counts like typing; only the undo of our own removal is let alone.
				for (const k of undoing ? [] : result.removeBare)
				{
					state.pending.add(k);
					const s = after.find(x => x.key == k);
					if (s && hint.isVoid(s.retType))
					{
						state.pendingVoid.add(k);
					}
				}
				// A bare `return` in a function whose type is missing or no type at all, in the functions that were just edited.
				for (const k of hint.emptyReturnsWithoutType(after, isKnown))
				{
					if (touched.includes(k) && !state.suppressed.has(k))
					{
						state.pending.add(k);
					}
				}
				if (state.pending.size)
				{
					if (state.timer)
					{
						clearTimeout(state.timer);
					}
					state.timer = setTimeout(function ()
					{
						const keys = [...state.pending];
						const voids = [...state.pendingVoid];
						state.pending.clear();
						state.pendingVoid.clear();
						removeBare(document, keys, voids);
					}, REMOVE_DELAY_MS);
				}
			}
			if (options.directive)
			{
				const enter = event.contentChanges.find(c => c.rangeLength == 0 && /^(?:\r\n|\n)[ \t]*$/.test(c.text));
				const lineNo = (enter || event.contentChanges[0]).range.start.line;
				if (lineNo < document.lineCount && hint.DIRECTIVE.test(document.lineAt(lineNo).text.replace(/\r$/, "")))
				{
					if (state.dirTimer)
					{
						clearTimeout(state.dirTimer);
					}
					state.dirTimer = setTimeout(() => runDirective(document), enter ? 0 : DIRECTIVE_DELAY_MS);
				}
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
		if (state && state.dirTimer)
		{
			clearTimeout(state.dirTimer);
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

module.exports = { registerReturnHint, readOptions, armIdle: (document, line) => armIdle(document, line) };
