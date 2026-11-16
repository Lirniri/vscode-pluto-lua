// Select the name of a class and the classes that extend it show up in a peek window, if they are out of sight.
// The pure part of it, free of VS Code dependencies.

"use strict";

const NAME = /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/;
const NAME_PART = /[A-Za-z0-9_\u0080-￿]/;

/**
 * The name that is selected as a whole: the selection is exactly one identifier, not a part of a longer one.
 * @param {string} lineText The line of the selection.
 * @param {number} start The column the selection starts at.
 * @param {number} end The column it ends at.
 * @returns {string|null}
 */
function selectedName(lineText, start, end)
{
	const text = lineText.slice(start, end);
	if (!NAME.test(text) || (start > 0 && NAME_PART.test(lineText[start - 1])) || (end < lineText.length && NAME_PART.test(lineText[end])))
	{
		return null;
	}
	return text;
}

/**
 * Of the heirs those that are out of sight: in another file, or in this one outside of the lines on the screen.
 * What is on the screen needs no window, the selected name is marked there already.
 * @template {{ key: string, line: number }} T
 * @param {T[]} heirs Where they are declared: the file and the line.
 * @param {string} currentKey The file that is open in the editor.
 * @param {{ start: number, end: number }[]} visible The lines that are on the screen.
 * @returns {T[]}
 */
function outOfSight(heirs, currentKey, visible)
{
	return heirs.filter(h => h.key != currentKey || !visible.some(r => r.start <= h.line && h.line <= r.end));
}

module.exports = { selectedName, outOfSight };
