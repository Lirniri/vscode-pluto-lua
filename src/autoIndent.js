// Indentation on Enter that keeps empty lines inside blocks indented (so the indent guides are not cut), and puts the
// indent after `case ...:` / `default:` by a setting. Free of VS Code dependencies so it can be unit-tested.

"use strict";

/** One level of indentation: a tab, or `tabSize` spaces. */
function indentUnit(options)
{
	return options && options.insertSpaces === false ? "\t" : " ".repeat(Math.max(1, Number(options && options.tabSize) || 4));
}

const leadingWhitespace = (line) => /^[ \t]*/.exec(line)[0];
const isBlank = (line) => line.trim() === "";

/** Width of whitespace, a tab counting as `tabSize` columns. */
function widthOf(ws, tabSize)
{
	let width = 0;
	for (const c of ws)
	{
		width += c == "\t" ? (tabSize || 4) : 1;
	}
	return width;
}

/** The code of a line: strings emptied, the comment cut off. */
function codeOf(line)
{
	let out = "";
	let quote = null;
	for (let i = 0; i < line.length; ++i)
	{
		const c = line[i];
		if (quote)
		{
			if (c == "\\")
			{
				++i;
				out += "  ";
			}
			else if (c == quote)
			{
				quote = null;
				out += c;
			}
			else
			{
				out += " ";
			}
		}
		else if (c == "\"" || c == "'")
		{
			quote = c;
			out += c;
		}
		else if (c == "-" && line[i + 1] == "-")
		{
			break;
		}
		else
		{
			out += c;
		}
	}
	return out.replace(/\s+$/, "");
}

/** Whether a line is `case ...:` or `default:`. */
function isCaseLine(line)
{
	const code = codeOf(line);
	return /^\s*(?:case\b(?!\s*(?:=(?!=)|[.,])).*|default\s*:?)$/.test(code) && !/\bend$/.test(code);
}

/**
 * Whether the line after `line` goes one level deeper: `true`, `"case"` (only with the setting for case labels), or `false`.
 * @param {string} line
 */
function increasesAfter(line)
{
	const code = codeOf(line);
	if (!code.trim())
	{
		return false;
	}
	if (isCaseLine(line))
	{
		return "case";
	}
	if (/\bend\)?[,;]?$/.test(code))
	{
		return false; // `if x then return end`
	}
	let depth = 0;
	for (const c of code)
	{
		depth += "([{".includes(c) ? 1 : (")]}".includes(c) ? -1 : 0);
	}
	if (depth > 0)
	{
		return true;
	}
	if (/(?<![.:\w])(?:do|then|else|repeat|begin|try|finally)$/.test(code) || /^\s*(?:else|catch|pluto_catch|finally|try|pluto_try)\b/.test(code))
	{
		return true;
	}
	if (/\bfunction\b[^()]*\([^()]*\)\s*(?::\s*[^=]+)?$/.test(code))
	{
		return true;
	}
	return /^\s*(?:(?:local|export|static|public|private|protected)\s+)*(?:class|pluto_class)\s+[\w.]+(?:\s+extends\s+[\w.]+)?$/.test(code);
}

/**
 * The indentation an empty line at `index` should have: that of the last line with code above it, one level deeper after an
 * opener.
 * @param {(i: number) => string} lineAt
 * @param {number} index
 * @param {{ insertSpaces?: boolean, tabSize?: number }} editorOptions
 * @param {{ indentAfterCase?: boolean }} [opts]
 */
function indentForEmptyLine(lineAt, index, editorOptions, opts)
{
	let i = index - 1;
	while (i >= 0 && isBlank(lineAt(i)))
	{
		--i;
	}
	if (i < 0)
	{
		return "";
	}
	const base = leadingWhitespace(lineAt(i));
	const inc = increasesAfter(lineAt(i));
	if (inc === true || (inc == "case" && !(opts && opts.indentAfterCase === false)))
	{
		return base + indentUnit(editorOptions);
	}
	return base;
}

const ENTER = /^\r?\n[ \t]*$/;

/**
 * What to fix after Enter was pressed at the end of line `line` (the new line is `line + 1`).
 * @param {(i: number) => string} lineAt The lines after the change.
 * @param {number} line
 * @param {{ insertSpaces?: boolean, tabSize?: number }} editorOptions
 * @param {{ enabled?: boolean, preserveEmptyLines?: boolean, indentAfterCase?: boolean }} opts
 * @returns {{ line: number, text: string }[]} Whole new texts of lines that have to change.
 */
function planEnter(lineAt, line, editorOptions, opts)
{
	opts = Object.assign({ enabled: true, preserveEmptyLines: true, indentAfterCase: true }, opts);
	const edits = [];
	if (!opts.enabled)
	{
		return edits;
	}
	const current = lineAt(line);
	const next = lineAt(line + 1);
	if (next === undefined || !isBlank(next))
	{
		return edits; // Enter in the middle of a line: the editor's own rules
	}
	if (isBlank(current))
	{
		if (!opts.preserveEmptyLines)
		{
			return edits;
		}
		// An empty line that lost its indentation gets the indentation of the block; the new line keeps it.
		const keep = current === "" ? indentForEmptyLine(lineAt, line, editorOptions, opts) : current;
		if (keep !== current)
		{
			edits.push({ line, text: keep });
		}
		if (widthOf(next, editorOptions.tabSize) < widthOf(keep, editorOptions.tabSize))
		{
			edits.push({ line: line + 1, text: keep });
		}
		return edits;
	}
	if (isCaseLine(current))
	{
		const want = leadingWhitespace(current) + (opts.indentAfterCase === false ? "" : indentUnit(editorOptions));
		if (next !== want)
		{
			edits.push({ line: line + 1, text: want });
		}
	}
	return edits;
}

/** Lines that are only whitespace, as `{ line, length }`, for the cleaning on save. */
function whitespaceOnlyLines(lineAt, count)
{
	const out = [];
	for (let i = 0; i < count; ++i)
	{
		const text = lineAt(i);
		if (text.length && isBlank(text))
		{
			out.push({ line: i, length: text.length });
		}
	}
	return out;
}

module.exports = { indentUnit, widthOf, codeOf, isCaseLine, increasesAfter, indentForEmptyLine, planEnter, whitespaceOnlyLines, ENTER };
