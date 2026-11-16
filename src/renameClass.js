// Rename of a class: the places that change are the declaration (`class Entity`) and the classes that say
// `extends Entity`. The pure part, free of VS Code dependencies.

"use strict";

const { RESERVED } = require("./parser");

/**
 * @typedef {{ key: string, line: number, col: number, endCol: number, kind: "declaration"|"extends" }} Place
 */

/**
 * The places where the name of a class stands: its declarations, and the `extends` of its direct heirs.
 * @param {import("./workspaceIndex").WorkspaceIndex} index
 * @param {string} name
 * @returns {Place[]} The declarations first, then the heirs; in the order of the files and lines.
 */
function renamePlaces(index, name)
{
	const places = [];
	for (const decl of index.classes(name))
	{
		if (decl.file)
		{
			places.push({ key: decl.file.key, line: decl.line, col: decl.col, endCol: decl.col + name.length, kind: "declaration" });
		}
	}
	for (const heir of index.subclasses(name))
	{
		// only a direct heir has the name in its `extends`; the ones further down the chain name another class
		if (heir.depth == 1 && heir.sym.extendsAt)
		{
			const at = heir.sym.extendsAt;
			places.push({ key: heir.file.key, line: at.line, col: at.col, endCol: at.endCol, kind: "extends" });
		}
	}
	const order = (p) => (p.kind == "declaration" ? 0 : 1);
	return places.sort((a, b) => order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.line - b.line || a.col - b.col));
}

/**
 * Whether `name` can be the new name of a class.
 * @param {string} name
 * @param {string} oldName
 * @returns {"empty"|"invalid"|"reserved"|"same"|null} What is wrong with it, null when nothing.
 */
function checkNewName(name, oldName)
{
	if (!name)
	{
		return "empty";
	}
	if (!/^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/.test(name))
	{
		return "invalid";
	}
	if (RESERVED.has(name))
	{
		return "reserved";
	}
	return name == oldName ? "same" : null;
}

module.exports = { renamePlaces, checkNewName };
