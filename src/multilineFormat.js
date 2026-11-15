// Smart formatting of multi-line parameter lists of functions and multi-line tables:
//  - a first element typed right after `(` / `{` of a bracket pair whose closer is on a line of its own moves to the
//    line below, one level deeper;
//  - Enter at the end of an element inside such brackets adds the missing comma.
// Free of VS Code dependencies so it can be unit-tested with plain Node.

"use strict";

const { tokenize } = require("./parser");

/** Keywords that open a block closed by `end` (`repeat` is closed by `until`). */
const BLOCK_OPENERS = new Set(["function", "if", "for", "while", "repeat", "switch", "pluto_switch", "try", "pluto_try", "class", "pluto_class", "enum", "pluto_enum"]);
/** Blocks whose header ends with `do`, which is then not a block of its own. */
const NEEDS_DO = new Set(["for", "while", "switch", "pluto_switch"]);
const CLOSER_OF = { "(": ")", "{": "}", "[": "]" };

/** The line without its `--` comment. */
function stripComment(line)
{
	let quote = null;
	for (let i = 0; i < line.length; ++i)
	{
		const c = line[i];
		if (quote)
		{
			if (c == "\\")
			{
				++i;
			}
			else if (c == quote)
			{
				quote = null;
			}
		}
		else if (c == "\"" || c == "'")
		{
			quote = c;
		}
		else if (c == "-" && line[i + 1] == "-")
		{
			return line.slice(0, i);
		}
	}
	return line;
}

const isP = (tok, v) => !!tok && tok.t == "p" && tok.v == v;
const isId = (tok, v) => !!tok && tok.t == "id" && (v === undefined || tok.v == v);

/** Whether the `function` keyword at token `fi` is a type (`x: function(a): int`, `$type F = function(...)`), not a function. */
function isFunctionType(tokens, fi)
{
	if (isP(tokens[fi - 1], ":"))
	{
		return true;
	}
	let first = fi;
	while (first > 0 && tokens[first - 1].line == tokens[fi].line)
	{
		--first;
	}
	return isP(tokens[first], "$");
}

/** Whether the `(` at token `idx` starts the parameter list of a function declaration (`function a.b:c(`, `function(`). */
function isParamsParen(tokens, idx)
{
	let k = idx - 1;
	if (isId(tokens[k], "function"))
	{
		return !isFunctionType(tokens, k);
	}
	while (k >= 1 && isId(tokens[k]) && (isP(tokens[k - 1], ".") || isP(tokens[k - 1], ":")))
	{
		k -= 2;
	}
	return k >= 1 && isId(tokens[k]) && isId(tokens[k - 1], "function") && !isFunctionType(tokens, k - 1);
}

/** Whether the `{` at token `idx` opens the body of a lambda (`|x| -> int { ... }`) rather than a table. */
function isLambdaBody(tokens, idx)
{
	let k = idx - 1;
	if (isP(tokens[k], "?"))
	{
		--k;
	}
	if (isId(tokens[k]) && isP(tokens[k - 1], "->"))
	{
		return true;
	}
	return isP(tokens[idx - 1], "->");
}

/**
 * The brackets and blocks that are open at the end of a line, and where the innermost bracket is closed.
 * @param {string} text
 * @param {number} line
 * @returns {{ tokens: import("./parser").Token[], stack: object[] }}
 *   `stack` holds entries `{ kind: "bracket", ch, idx, token, params, table, closeIdx }` and `{ kind: "block", name }`,
 *   outermost first; `closeIdx` is the token index of the matching closer, or -1 when there is none.
 */
function analyze(text, line)
{
	const tokens = tokenize(text);
	const stack = [];
	let snapshot = null;
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (!snapshot && tok.line > line)
		{
			snapshot = stack.slice();
		}
		if (tok.t == "p")
		{
			if (tok.v == "(" || tok.v == "{" || tok.v == "[")
			{
				stack.push({
					kind: "bracket", ch: tok.v, idx, token: tok, closeIdx: -1,
					params: tok.v == "(" && isParamsParen(tokens, idx),
					table: tok.v == "{" && !isLambdaBody(tokens, idx),
				});
			}
			else if (tok.v == ")" || tok.v == "}" || tok.v == "]")
			{
				for (let k = stack.length - 1; k >= 0; --k)
				{
					if (stack[k].kind == "bracket" && CLOSER_OF[stack[k].ch] == tok.v)
					{
						stack[k].closeIdx = idx;
						stack.length = k;
						break;
					}
				}
			}
		}
		else if (tok.t == "id")
		{
			const v = tok.v;
			if (v == "end" || v == "until")
			{
				for (let k = stack.length - 1; k >= 0; --k)
				{
					if (stack[k].kind == "block" && (v == "until" ? stack[k].name == "repeat" : true))
					{
						stack.length = k;
						break;
					}
				}
			}
			else if (v == "do")
			{
				const top = stack[stack.length - 1];
				if (top && top.kind == "block" && top.needsDo)
				{
					top.needsDo = false;
				}
				else
				{
					stack.push({ kind: "block", name: "do" });
				}
			}
			else if (BLOCK_OPENERS.has(v) && !isP(tokens[idx - 1], ".") && !isP(tokens[idx - 1], ":"))
			{
				const afterEnum = (v == "class" || v == "pluto_class") && (isId(tokens[idx - 1], "enum") || isId(tokens[idx - 1], "pluto_enum"));
				if (!afterEnum && !(v == "function" && isFunctionType(tokens, idx)))
				{
					stack.push({ kind: "block", name: v, needsDo: NEEDS_DO.has(v) });
				}
			}
		}
	}
	return { tokens, stack: snapshot || stack.slice() };
}

/** Leading whitespace of a line. */
function indentOf(line)
{
	return /^[ \t]*/.exec(line)[0];
}

/** Whether a bracket entry is a list the options ask to format. */
function isWanted(entry, options)
{
	return !!entry && entry.kind == "bracket" && ((entry.params && options.params) || (entry.table && options.tables));
}

// A line that ends like this goes on (or is empty): no comma yet.
const UNFINISHED = /(?:[(\[{=+\-*\/%^&|~<>,:]|(?<!\.)\.\.|(?:^|[^\w])(?:and|or|not))$/;

/**
 * What to do after Enter was pressed at the end of an element in a multi-line parameter list or table: put the
 * missing comma at the end of the element and give the new line the indentation of the element.
 * @param {string} text The document after Enter.
 * @param {number} line The line Enter was pressed on (the new line is `line + 1`).
 * @param {{ params: boolean, tables: boolean }} options
 * @returns {{ edits: { line: number, col: number, endLine: number, endCol: number, text: string }[], cursor: { line: number, col: number } }|null}
 */
function planEnter(text, line, options)
{
	const lines = text.split(/\r?\n/);
	const current = lines[line];
	const fresh = lines[line + 1];
	if (current === undefined || fresh === undefined || fresh.trim() != "")
	{
		return null;
	}
	const code = stripComment(current).replace(/\s+$/, "");
	if (!code.trim())
	{
		return null; // an empty line: only a line break
	}
	const { tokens, stack } = analyze(text, line);
	const top = stack[stack.length - 1];
	if (!isWanted(top, options) || top.closeIdx == -1 || tokens[top.closeIdx].line <= line + 1)
	{
		return null; // not in such a list, or no closer below the new line
	}
	if (top.token.line >= line)
	{
		return null; // the line opens the list itself: the editor indents what comes next
	}
	const edits = [];
	const last = code[code.length - 1];
	const isTable = top.ch == "{";
	// A trailing `;` separates the fields of a table as well as `,`.
	const separated = last == "," || (isTable && last == ";");
	if (!separated && UNFINISHED.test(code))
	{
		return null; // the expression goes on (`a = 1 +`) or the line opens a list: not the end of an element
	}
	// `...` has to be the last parameter, so nothing follows it.
	if (!separated && !(top.params && /\.\.\.$/.test(code)))
	{
		edits.push({ line, col: code.length, endLine: line, endCol: code.length, text: "," });
	}
	const indent = indentOf(current);
	if (fresh != indent)
	{
		edits.push({ line: line + 1, col: 0, endLine: line + 1, endCol: fresh.length, text: indent });
	}
	return { edits, cursor: { line: line + 1, col: indent.length } };
}

/**
 * What to do after a character was typed on `line` with the cursor at `col`: if the line is the opener of a
 * parameter list or table whose closer is on a line of its own, and what was typed is its first element, move
 * the element to the line below, one level deeper.
 * @param {string} text The document after the edit.
 * @param {number} line
 * @param {number} col The cursor.
 * @param {{ params: boolean, tables: boolean }} options
 * @param {string} unit One level of indentation.
 * @param {string} eol
 * @returns {{ edits: { line: number, col: number, endLine: number, endCol: number, text: string }[], cursor: { line: number, col: number } }|null}
 */
function planFirstElement(text, line, col, options, unit, eol)
{
	const lines = text.split(/\r?\n/);
	const current = lines[line];
	if (current === undefined)
	{
		return null;
	}
	// The rest of the line may only be what the editor closes on its own: quotes and inner brackets.
	if (!/^[\s"')\]]*$/.test(current.slice(col)))
	{
		return null;
	}
	const { tokens, stack } = analyze(text, line);
	const top = stack[stack.length - 1];
	if (!isWanted(top, options) || top.token.line != line || top.closeIdx == -1)
	{
		return null;
	}
	const openCol = top.token.col;
	if (col <= openCol + 1 || tokens[top.closeIdx].line <= line)
	{
		return null; // the closer is on the same line: a one-line list
	}
	// Nothing but the first element may be inside: all tokens up to the closer are on this line.
	const inside = tokens.slice(top.idx + 1, top.closeIdx);
	if (!inside.length || inside.some(t => t.line != line) || inside[0].col < openCol + 1)
	{
		return null;
	}
	const typed = current.slice(openCol + 1).replace(/^\s+/, "");
	if (!typed.trim() || /^[)}\]]/.test(typed))
	{
		return null;
	}
	const indent = indentOf(current) + unit;
	const before = current.slice(openCol + 1, col).replace(/^\s+/, "");
	return {
		edits: [{ line, col: openCol + 1, endLine: line, endCol: current.length, text: eol + indent + typed }],
		cursor: { line: line + 1, col: indent.length + before.length },
	};
}

module.exports = { stripComment, analyze, planEnter, planFirstElement, indentOf, isParamsParen, isLambdaBody, UNFINISHED };
