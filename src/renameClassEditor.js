// F2 on the name of a class: a peek window lists the places that will change (the declaration and the classes that
// extend it), then the new name is asked for, and every place gets it.

"use strict";

const vscode = require("vscode");
const { renamePlaces, checkNewName } = require("./renameClass");
const { t } = require("./i18n");

/**
 * @param {vscode.ExtensionContext} context
 * @param {import("./extension").LanguageService} service
 */
function registerRenameClass(context, service)
{
	context.subscriptions.push(vscode.commands.registerCommand("plua.renameClass", async function ()
	{
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId != "pluto")
		{
			return;
		}
		const document = editor.document;
		const range = document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*/);
		service.getRecord(document);
		const name = range ? document.getText(range) : "";
		if (!name || !service.index.classes(name).length)
		{
			vscode.window.showInformationMessage(t("rename.notClass"));
			return;
		}
		const places = renamePlaces(service.index, name);
		const config = vscode.workspace.getConfiguration("plua", document.uri);
		let peeked = false;
		if (config.get("renameClassPeek", true) && places.length)
		{
			const locations = places.map(p => new vscode.Location(vscode.Uri.parse(p.key, true), new vscode.Range(p.line, p.col, p.line, p.endCol)));
			await vscode.commands.executeCommand("editor.action.peekLocations", document.uri, range.start, locations, "peek");
			peeked = true;
		}
		const taken = (n) => service.index.classes(n).length > 0;
		let entered;
		try
		{
			entered = await vscode.window.showInputBox({
				title: t("rename.title", name),
				prompt: t("rename.prompt", places.length),
				value: name,
				valueSelection: [0, name.length],
				validateInput(value)
				{
					const problem = checkNewName(value, name);
					if (problem == "same")
					{
						return undefined;
					}
					if (problem)
					{
						return t("rename." + problem);
					}
					return taken(value) ? { message: t("rename.exists", value), severity: vscode.InputBoxValidationSeverity.Warning } : undefined;
				},
			});
		}
		finally
		{
			if (peeked)
			{
				vscode.commands.executeCommand("closeReferenceSearch");
			}
		}
		if (entered === undefined || checkNewName(entered, name))
		{
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		for (const p of places)
		{
			edit.replace(vscode.Uri.parse(p.key, true), new vscode.Range(p.line, p.col, p.line, p.endCol), entered);
		}
		await vscode.workspace.applyEdit(edit);
	}));
}

module.exports = { registerRenameClass };
