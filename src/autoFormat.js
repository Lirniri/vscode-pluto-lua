// Small helpers for typing: a new line after the comma of a multi-line list, ghost-text suggestions (`()` after
// `function`, ` = ` after `["key"]`, ` then` / ` do` after the header of a block), the duplicate names of parameters
// and table keys, and closers that do not fit the last opened bracket (`{ ]`). Free of VS Code dependencies so it
// can be unit-tested with plain Node.

"use strict";

const { tokenize } = require("./parser");
const { analyze, isParamsParen, isLambdaBody, stripComment, indentOf, UNFINISHED } = require("./multilineFormat");

const isP = (tok, v) => !!tok && tok.t == "p" && tok.v == v;
const OPENERS = { "(": ")", "{": "}", "[": "]" };
const CLOSERS = { ")": "(", "}": "{", "]": "[" };

/** Whether the end of `before` is code: not inside a comment or a string. */
function inCode(before)
{
	let quote = null;
	for (let i = 0; i < before.length; ++i)
	{
		const c = before[i];
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
		else if (c == "-" && before[i + 1] == "-")
		{
			return false;
		}
	}
	return !quote;
}

/** The innermost bracket that is open at an offset, with what it is (`params` of a function, `table`). */
function innermostBracketAt(text, offset)
{
	let lineEnd = text.indexOf("\n", offset);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	const tokens = tokenize(text.slice(0, lineEnd));
	const stack = [];
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (tok.off >= offset)
		{
			break;
		}
		if (tok.t != "p")
		{
			continue;
		}
		if (OPENERS[tok.v])
		{
			stack.push({ ch: tok.v, idx, token: tok, params: tok.v == "(" && isParamsParen(tokens, idx), table: tok.v == "{" && !isLambdaBody(tokens, idx) });
		}
		else if (CLOSERS[tok.v])
		{
			for (let k = stack.length - 1; k >= 0; --k)
			{
				if (stack[k].ch == CLOSERS[tok.v])
				{
					stack.length = k;
					break;
				}
			}
		}
	}
	return stack[stack.length - 1] || null;
}

// ---------------------------------------------------------------------------------------------
// A new line after the comma
// ---------------------------------------------------------------------------------------------

/**
 * After a comma was typed at the end of an element of a multi-line parameter list or table: a new line with the
 * indentation of the elements, in which the next one is written.
 * @param {string} text
 * @param {number} line The line of the comma.
 * @param {{ params: boolean, tables: boolean }} options
 * @param {string} unit One level of indentation.
 * @param {string} eol
 * @returns {{ edits: { line: number, col: number, endLine: number, endCol: number, text: string }[], cursor: { line: number, col: number } }|null}
 */
function planCommaNewLine(text, line, options, unit, eol)
{
	const lines = text.split(/\r?\n/);
	const current = lines[line];
	if (current === undefined || !stripComment(current).replace(/\s+$/, "").endsWith(","))
	{
		return null;
	}
	const next = lines[line + 1];
	if (next !== undefined && next.trim() == "")
	{
		return null; // there is a line for the next element already
	}
	const { tokens, stack } = analyze(text, line);
	const top = stack[stack.length - 1];
	const wanted = !!top && top.kind == "bracket" && ((top.params && options.params) || (top.table && options.tables));
	if (!wanted || top.closeIdx == -1 || tokens[top.closeIdx].line <= line)
	{
		return null; // not in such a list, or its closer is on this line
	}
	// Elements stand one level deeper than the line with the bracket.
	const indent = top.token.line == line ? indentOf(current) + unit : indentOf(current);
	return {
		edits: [{ line, col: current.length, endLine: line, endCol: current.length, text: eol + indent }],
		cursor: { line: line + 1, col: indent.length },
	};
}

// ---------------------------------------------------------------------------------------------
// Ghost-text suggestions
// ---------------------------------------------------------------------------------------------

function balanced(code)
{
	const stack = [];
	for (const c of code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, ""))
	{
		if (OPENERS[c])
		{
			stack.push(OPENERS[c]);
		}
		else if (CLOSERS[c] && stack.pop() != c)
		{
			return false;
		}
	}
	return stack.length == 0;
}

/**
 * What can follow the cursor as a suggestion shown in grey: `()` after `function`, ` = ` after the key `["a"]` of a
 * table, ` then` after the header of `if` / `elseif`, ` do` after the header of `while` / `for`.
 * @param {string} text
 * @param {number} offset
 * @param {{ parens?: boolean, keyAssign?: boolean, blockWords?: boolean }} options Which suggestions are wanted.
 * @returns {{ kind: "parens"|"key"|"then"|"do", insert: string, snippet?: string }|null}
 */
function inlineSuggestionAt(text, offset, options)
{
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	let lineEnd = text.indexOf("\n", offset);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
	const col = offset - lineStart;
	const before = line.slice(0, col);
	const after = line.slice(col);
	if (!inCode(before))
	{
		return null;
	}

	// `function` or `function name`: the parameters.
	if (options.parens)
	{
		const m = /(?:^|[^\w.:$])function(?:\s+([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*))?$/.exec(before);
		if (m && !/^\s*\(/.test(after) && !/^[\w.:]/.test(after))
		{
			const head = before.slice(0, m.index + m[0].indexOf("function")).replace(/\s+$/, "");
			const afterType = /(?::|\||->)$/.test(head);
			// `local function` / `public function` without a name is not finished: the name comes first.
			const needsName = /(?:^|\s)(?:local|export|public|private|protected|static|global|\$declare)$/.test(head);
			if (!afterType && !(needsName && !m[1]))
			{
				return { kind: "parens", insert: "()", snippet: "($0)" };
			}
		}
	}

	// `["key"]` at the start of a field of a table: ` = `.
	if (options.keyAssign && /^\s*(?:=|$|[,;}])/.test(after) && !/^\s*=/.test(after))
	{
		const m = /(^|[{,;])\s*\[(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\[\]"']+)\]$/.exec(before);
		if (m)
		{
			const top = innermostBracketAt(text, offset);
			let startsField = m[1] != "";
			if (!startsField)
			{
				// At the start of a line: the line above has to end an element or open the table.
				const above = text.slice(0, lineStart).split("\n").reverse().map(l => stripComment(l).trim()).find(l => l);
				startsField = !!above && /[{,;]$/.test(above);
			}
			if (top && top.table && startsField)
			{
				return { kind: "key", insert: " = " };
			}
		}
	}

	// The header of a block.
	if (options.blockWords && after.trim() == "")
	{
		const code = stripComment(before).replace(/\s+$/, "");
		const space = /\s$/.test(before) ? "" : " ";
		const finished = (cond) => cond.length > 0 && balanced(cond) && !UNFINISHED.test(cond) && !/(?:^|\W)(?:and|or|not)$/.test(cond);
		let m = /^\s*(?:else)?if\s+(\S.*)$/.exec(code);
		if (m && !/\bthen\b/.test(m[1]) && finished(m[1]))
		{
			return { kind: "then", insert: space + "then" };
		}
		m = /^\s*while\s+(\S.*)$/.exec(code);
		if (m && !/\bdo\b/.test(m[1]) && finished(m[1]))
		{
			return { kind: "do", insert: space + "do" };
		}
		m = /^\s*for\s+(\S.*)$/.exec(code);
		if (m && !/\bdo\b/.test(m[1]) && finished(m[1]) && (/^[\w\s,]+\s+in\s+\S/.test(m[1]) || /^\w+\s*=\s*[^,]+,\s*\S/.test(m[1])))
		{
			return { kind: "do", insert: space + "do" };
		}
	}
	return null;
}

// ---------------------------------------------------------------------------------------------
// Duplicate names
// ---------------------------------------------------------------------------------------------

/**
 * Parameters of a function or lambda, and keys of a table, that are written twice.
 * @param {string} text
 * @returns {{ kind: "param"|"key", name: string, line: number, col: number, endCol: number, firstLine: number }[]}
 *   One entry for every repetition, at the later one.
 */
function findDuplicates(text)
{
	const tokens = tokenize(text);
	const out = [];
	const note = function (seen, kind, name, tok)
	{
		if (seen.has(name))
		{
			out.push({ kind, name: kind == "key" ? name : name, line: tok.line, col: tok.col, endCol: tok.col + (tok.end - tok.off), firstLine: seen.get(name) });
		}
		else
		{
			seen.set(name, tok.line);
		}
	};
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (tok.t != "p")
		{
			continue;
		}
		if (tok.v == "(" && isParamsParen(tokens, idx))
		{
			// The parameters of a function declaration: the first identifier after `(`, `,` and `...`.
			const seen = new Map();
			let depth = 0;
			let expect = true;
			for (let k = idx + 1; k < tokens.length; ++k)
			{
				const t = tokens[k];
				if (t.t == "p" && OPENERS[t.v])
				{
					++depth;
				}
				else if (t.t == "p" && CLOSERS[t.v])
				{
					if (depth == 0)
					{
						break;
					}
					--depth;
				}
				else if (depth == 0 && isP(t, ","))
				{
					expect = true;
				}
				else if (depth == 0 && expect && t.t == "id" && (isP(tokens[k + 1], ":") || isP(tokens[k + 1], ",") || isP(tokens[k + 1], "=") || isP(tokens[k + 1], ")") || tokens[k + 1] === undefined))
				{
					note(seen, "param", t.v, t);
					expect = false;
				}
				else if (depth == 0 && !isP(t, "..."))
				{
					expect = false;
				}
			}
		}
		else if (tok.v == "|")
		{
			// A lambda `|a, b: int| -> ...`: the names between the bars.
			let close = -1;
			for (let k = idx + 1; k < tokens.length && k < idx + 60; ++k)
			{
				if (isP(tokens[k], "|"))
				{
					close = k;
					break;
				}
				if (tokens[k].t == "str" || tokens[k].line > tok.line + 1 || (tokens[k].t == "p" && !["," , ":", "?", ".", "{", "}"].includes(tokens[k].v)))
				{
					break;
				}
			}
			if (close != -1 && isP(tokens[close + 1], "->"))
			{
				const seen = new Map();
				let expect = true;
				for (let k = idx + 1; k < close; ++k)
				{
					if (isP(tokens[k], ","))
					{
						expect = true;
					}
					else if (expect && tokens[k].t == "id")
					{
						note(seen, "param", tokens[k].v, tokens[k]);
						expect = false;
					}
					else
					{
						expect = false;
					}
				}
				idx = close;
			}
		}
		else if (tok.v == "{" && !isLambdaBody(tokens, idx))
		{
			// The fields of a table that are given a name: `name = ...` and `["name"] = ...`.
			const seen = new Map();
			let depth = 0;
			let atStart = true;
			for (let k = idx + 1; k < tokens.length; ++k)
			{
				const t = tokens[k];
				if (depth == 0 && atStart && t.t != "p" || (depth == 0 && atStart && isP(t, "[")))
				{
					atStart = false;
					if (t.t == "id" && isP(tokens[k + 1], "="))
					{
						note(seen, "key", t.v, t);
					}
					else if (isP(t, "[") && tokens[k + 1] && ["str", "num"].includes(tokens[k + 1].t) && isP(tokens[k + 2], "]") && isP(tokens[k + 3], "="))
					{
						note(seen, "key", tokens[k + 1].v, tokens[k + 1]);
						k += 2; // the `]` of the key
					}
					else if (isP(t, "["))
					{
						++depth;
					}
				}
				else if (t.t == "p" && OPENERS[t.v])
				{
					++depth;
					atStart = false;
				}
				else if (t.t == "p" && CLOSERS[t.v])
				{
					if (depth == 0)
					{
						break;
					}
					--depth;
				}
				else if (depth == 0 && (isP(t, ",") || isP(t, ";")))
				{
					atStart = true;
				}
				else
				{
					atStart = false;
				}
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Closers that do not fit
// ---------------------------------------------------------------------------------------------

/**
 * Closing brackets that are not the one the last opened bracket needs, and match no other open bracket (`{ ]`).
 * A closer that fits a bracket further out (`{ a[1 }`) means a forgotten closer, which is left to the compiler.
 * @param {string} text
 * @returns {{ line: number, col: number, endCol: number, off: number, found: string, expected: string, openLine: number, openCol: number }[]}
 */
function findBracketMismatches(text)
{
	const tokens = tokenize(text);
	const out = [];
	const stack = [];
	for (const tok of tokens)
	{
		if (tok.t != "p")
		{
			continue;
		}
		if (OPENERS[tok.v])
		{
			stack.push(tok);
		}
		else if (CLOSERS[tok.v])
		{
			const top = stack[stack.length - 1];
			if (!top)
			{
				continue; // nothing is open
			}
			if (CLOSERS[tok.v] == top.v)
			{
				stack.pop();
				continue;
			}
			const deeper = stack.findIndex(o => o.v == CLOSERS[tok.v]);
			if (deeper != -1)
			{
				stack.length = deeper; // the closers in between were forgotten
				continue;
			}
			out.push({ line: tok.line, col: tok.col, endCol: tok.col + 1, off: tok.off, found: tok.v, expected: OPENERS[top.v], openLine: top.line, openCol: top.col });
			stack.pop(); // taken for the closer it should be
		}
	}
	return out;
}

module.exports = { inCode, innermostBracketAt, planCommaNewLine, inlineSuggestionAt, findDuplicates, findBracketMismatches };
