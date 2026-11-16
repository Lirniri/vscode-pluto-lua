// Small helpers for typing: a new line after the comma of a multi-line list, ghost-text suggestions (`()` after
// `function`, ` = ` after `["key"]`, ` then` / ` do` after the header of a block), the duplicate names of parameters
// and table keys, and closers that do not fit the last opened bracket (`{ ]`). Free of VS Code dependencies so it
// can be unit-tested with plain Node.

"use strict";

const { tokenize, RESERVED } = require("./parser");
const { t, getLanguage } = require("./i18n");
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
 * table, ` then` or ` do` after the header of `if` / `elseif`, ` do` after the header of `while` / `for`.
 * @param {string} text
 * @param {number} offset
 * @param {{ parens?: boolean, keyAssign?: boolean, blockWords?: boolean, ifWord?: "then"|"do"|null }} options Which suggestions are wanted.
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
		if (m && !/\b(?:then|do)\b/.test(m[1]) && finished(m[1]))
		{
			// `if x do` is as valid as `if x then`: which one is suggested is a choice (the default is `then`).
			const word = options.ifWord === undefined ? "then" : options.ifWord;
			return word ? { kind: word, insert: space + word } : null;
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
// then or do after `if`, and the suggestions for `for`
// ---------------------------------------------------------------------------------------------

/** The words used for the variables of a loop: short (`i`, `k`, `v`, `t`) or full (`index`, `key`, `value`, `table_name`). */
const NAME_STYLES = {
	short: { index: "i", key: "k", value: "v", table: "t" },
	full: { index: "index", key: "key", value: "value", table: "table_name" },
};

/**
 * @param {"short"|"full"|string} style
 * @param {Record<string, unknown>} [overrides] The user's own words, e.g. `{ "value": "item" }`; what is not a name is ignored.
 * @returns {{ index: string, key: string, value: string, table: string }}
 */
function namesFor(style, overrides)
{
	const names = Object.assign({}, NAME_STYLES[style == "full" ? "full" : "short"]);
	if (overrides && typeof overrides == "object")
	{
		for (const k of Object.keys(names))
		{
			const v = overrides[k];
			if (typeof v == "string" && /^[A-Za-z_]\w*$/.test(v) && !RESERVED.has(v))
			{
				names[k] = v;
			}
		}
	}
	return names;
}

/**
 * How many headers of `if` / `elseif` end with `then` and how many with `do` (both are valid in Pluto).
 * @param {string} text
 * @returns {{ then: number, do: number }}
 */
function countIfStyles(text)
{
	const tokens = tokenize(text);
	const count = { then: 0, do: 0 };
	for (let i = 0; i < tokens.length; ++i)
	{
		const tok = tokens[i];
		if (tok.t != "id" || (tok.v != "if" && tok.v != "elseif") || isP(tokens[i - 1], ".") || isP(tokens[i - 1], ":"))
		{
			continue;
		}
		let depth = 0;
		for (let k = i + 1; k < tokens.length && k < i + 400; ++k)
		{
			const u = tokens[k];
			if (u.t == "p" && OPENERS[u.v])
			{
				++depth;
			}
			else if (u.t == "p" && CLOSERS[u.v])
			{
				--depth;
			}
			else if (depth <= 0 && u.t == "id")
			{
				if (u.v == "then" || u.v == "do")
				{
					++count[u.v];
					break;
				}
				if (u.v == "end" || u.v == "function" || u.v == "if")
				{
					break;
				}
			}
		}
	}
	return count;
}

/**
 * Which word to suggest after the header of an `if`.
 * @param {string} setting `auto`, `then`, `do` or `off`.
 * @param {{ then: number, do: number }} file What the current file uses.
 * @param {{ then: number, do: number }} [workspace] What the rest of the workspace uses.
 * @returns {"then"|"do"|null} null: nothing is suggested.
 */
function chooseIfWord(setting, file, workspace)
{
	if (setting == "then" || setting == "do")
	{
		return setting;
	}
	if (setting == "off")
	{
		return null;
	}
	for (const counts of [file, workspace])
	{
		if (counts && counts.then != counts.do)
		{
			return counts.do > counts.then ? "do" : "then";
		}
	}
	return "then";
}

/** The table literal assigned to a variable nearest before the cursor line: `local items = { 1, 2 }`. */
function nearestTable(text, offset)
{
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	const tokens = tokenize(text.slice(0, lineStart));
	let found = null;
	for (let i = 2; i < tokens.length; ++i)
	{
		if (!isP(tokens[i], "{") || !isP(tokens[i - 1], "=") || tokens[i - 2].t != "id" || isP(tokens[i - 3], ".") || isP(tokens[i - 3], ":") || RESERVED.has(tokens[i - 2].v))
		{
			continue;
		}
		let depth = 0;
		let close = -1;
		let keyed = false;
		for (let k = i + 1; k < tokens.length; ++k)
		{
			const t = tokens[k];
			if (t.t == "p" && OPENERS[t.v])
			{
				if (depth == 0 && t.v == "[")
				{
					keyed = true;
				}
				++depth;
			}
			else if (t.t == "p" && CLOSERS[t.v])
			{
				if (depth == 0)
				{
					close = k;
					break;
				}
				--depth;
			}
			else if (depth == 0 && isP(t, "="))
			{
				keyed = true;
			}
		}
		if (close != -1)
		{
			found = { name: tokens[i - 2].v, array: !keyed && close > i + 1 };
		}
	}
	return found;
}

/** Splits at the commas of the top level: `1, f(2, 3), 4` → [`1`, `f(2, 3)`, `4`]. */
function splitTopLevel(str)
{
	const parts = [];
	let depth = 0;
	let current = "";
	let quote = null;
	for (let i = 0; i < str.length; ++i)
	{
		const c = str[i];
		if (quote)
		{
			current += c;
			if (c == "\\")
			{
				current += str[++i] || "";
			}
			else if (c == quote)
			{
				quote = null;
			}
			continue;
		}
		if (c == "\"" || c == "'")
		{
			quote = c;
		}
		else if (OPENERS[c])
		{
			++depth;
		}
		else if (CLOSERS[c])
		{
			--depth;
		}
		if (c == "," && depth == 0)
		{
			parts.push(current);
			current = "";
		}
		else
		{
			current += c;
		}
	}
	parts.push(current);
	return parts;
}

/**
 * Suggestions while the header of a `for` is written: the kinds of loop after `for`, the iterator after `in`, the
 * limit of a numeric loop (the length of the nearest table) and its step. Several are offered, the most likely first.
 * @param {string} text
 * @param {number} offset
 * @param {{ names?: { index: string, key: string, value: string, table: string } }} [options]
 * @returns {{ kind: string, insert: string, snippet: string }[]}
 */
function forSuggestionsAt(text, offset, options)
{
	const names = (options && options.names) || NAME_STYLES.short;
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	let lineEnd = text.indexOf("\n", offset);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
	const before = line.slice(0, offset - lineStart);
	if (!inCode(before) || line.slice(offset - lineStart).trim() != "")
	{
		return [];
	}
	const table = nearestTable(text, offset);
	const tname = table ? table.name : names.table;
	const space = /\s$/.test(before) ? "" : " ";
	const out = [];
	const add = (kind, plain, snippet) => out.push({ kind, insert: space + plain, snippet: space + (snippet === undefined ? plain : snippet) });
	// The way through the table that fits it: `ipairs` for an array, `pairs` for fields.
	const arrayFirst = !table || table.array;

	if (/^\s*for\s?$/.test(before))
	{
		add("for-numeric", `${names.index} = 1, ${table ? "#" + tname : "10"}`, `\${1:${names.index}} = \${2:1}, \${3:${table ? "#" + tname : "10"}}`);
		const ipairs = () => add("for-ipairs", `${names.index}, ${names.value} in ipairs(${tname})`, `\${1:${names.index}}, \${2:${names.value}} in ipairs(\${3:${tname}})`);
		const pairs = () => add("for-pairs", `${names.key}, ${names.value} in pairs(${tname})`, `\${1:${names.key}}, \${2:${names.value}} in pairs(\${3:${tname}})`);
		if (arrayFirst)
		{
			ipairs();
			pairs();
		}
		else
		{
			pairs();
			ipairs();
		}
		add("for-as", `${tname} as ${names.value}`, `\${1:${tname}} as \${2:${names.value}}`);
		return out;
	}
	// After `in`: what to walk with.
	if (/^\s*for\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+in\s?$/.test(before))
	{
		const ipairs = () => add("for-ipairs", `ipairs(${tname})`, `ipairs(\${1:${tname}})`);
		const pairs = () => add("for-pairs", `pairs(${tname})`, `pairs(\${1:${tname}})`);
		if (arrayFirst)
		{
			ipairs();
			pairs();
		}
		else
		{
			pairs();
			ipairs();
		}
		add("for-next", `next, ${tname}`, `next, \${1:${tname}}`);
		return out;
	}
	// The limit and the step of a numeric loop.
	const m = /^\s*for\s+[A-Za-z_]\w*\s*=\s*(.*)$/.exec(before);
	if (m && /,\s?$/.test(m[1]) && balanced(m[1]))
	{
		const given = splitTopLevel(m[1]).slice(0, -1).map(p => p.trim());
		if (given.length == 1 && given[0] && table)
		{
			add("for-limit", `#${tname}`);
		}
		else if (given.length == 2 && given[0] && given[1])
		{
			const from = Number(given[0]);
			const to = Number(given[1]);
			const down = Number.isFinite(from) && Number.isFinite(to) && from > to;
			for (const step of Number.isFinite(from) && Number.isFinite(to) ? (down ? ["-1", "-2"] : ["1", "2"]) : ["1", "-1"])
			{
				add("for-step", step);
			}
		}
	}
	return out;
}

/** The inline suggestions at a place: one of the kinds above, or several for a `for`. */
function inlineSuggestionsAt(text, offset, options)
{
	const single = inlineSuggestionAt(text, offset, options);
	if (single)
	{
		return [single];
	}
	return options.forHints ? forSuggestionsAt(text, offset, options) : [];
}

/**
 * The word typed so far in front of the cursor at the end of a line (`th` of `if x th|`). The text and offset
 * without it are what the suggestions are made from: the line is judged as it was before the word was started.
 * @returns {{ word: string, text: string, offset: number }|null}
 */
function partialWordAt(text, offset)
{
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	let lineEnd = text.indexOf("\n", offset);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	if (text.slice(offset, lineEnd).trim() != "")
	{
		return null;
	}
	const m = /(?:^|\s)([A-Za-z_]\w*)$/.exec(text.slice(lineStart, offset));
	if (!m)
	{
		return null;
	}
	const start = offset - m[1].length;
	return { word: m[1], text: text.slice(0, start) + text.slice(offset), offset: start };
}

/**
 * Of suggestions made without a half-typed word, those that go on with it, cut to what is still missing:
 * `then` with `th` typed → `en`. A suggestion that does not start with the word, or is the word, falls out.
 * @param {{ insert: string, snippet?: string }[]} suggestions
 * @param {string} word
 */
function finishWord(suggestions, word)
{
	const cut = (s) =>
	{
		const body = s.trimStart();
		return body.length > word.length && body.startsWith(word) ? body.slice(word.length) : null;
	};
	const out = [];
	for (const s of suggestions)
	{
		const insert = cut(s.insert);
		const snippet = s.snippet == null ? undefined : cut(s.snippet);
		if (insert == null || (s.snippet != null && snippet == null))
		{
			continue;
		}
		out.push(Object.assign({}, s, s.snippet == null ? { insert } : { insert, snippet }));
	}
	return out;
}

/**
 * The values a numeric `for` goes through: `for i = 1, 10, 2` → 1, 3, 5, 7, 9.
 * @param {string} lineText
 * @returns {{ kind: "values"|"none"|"stepZero", name: string, from: number, to: number, step: number, total: number, values: string[], last: string }|null}
 *   null when the line is no numeric `for` with number literals.
 */
function describeNumericFor(lineText)
{
	const m = /^\s*for\s+([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:\bdo\b.*)?$/.exec(stripComment(lineText));
	if (!m)
	{
		return null;
	}
	const parts = splitTopLevel(m[2]).map(p => p.trim());
	const number = /^[-+]?\d+(?:\.\d+)?$/;
	if ((parts.length != 2 && parts.length != 3) || !parts.every(p => number.test(p)))
	{
		return null;
	}
	const from = Number(parts[0]);
	const to = Number(parts[1]);
	const step = parts.length == 3 ? Number(parts[2]) : 1;
	const base = { name: m[1], from, to, step, total: 0, values: [], last: "" };
	if (step == 0)
	{
		return Object.assign(base, { kind: "stepZero" });
	}
	if ((step > 0 && from > to) || (step < 0 && from < to))
	{
		return Object.assign(base, { kind: "none" });
	}
	const total = Math.floor((to - from) / step + 1e-9) + 1;
	const round = (x) => String(Number(x.toFixed(10)));
	const shown = total > 8 ? 6 : total;
	const values = [];
	for (let n = 0; n < shown; ++n)
	{
		values.push(round(from + n * step));
	}
	return Object.assign(base, { kind: "values", total, values, last: round(from + (total - 1) * step) });
}

/** "1 time", "5 times" (in Russian "1 раз", "2 раза", "5 раз"). */
function timesText(n)
{
	const ru = getLanguage() == "ru";
	const key = ru
		? (n % 10 == 1 && n % 100 != 11 ? "one" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "few" : "many"))
		: (n == 1 ? "one" : "many");
	return t("for.times." + key, n);
}

/** The text shown when hovering a numeric `for`: which values the variable takes. */
function forPreviewText(info)
{
	if (info.kind == "stepZero")
	{
		return t("for.stepZero");
	}
	if (info.kind == "none")
	{
		return t("for.none", info.name, String(info.from), String(info.to), String(info.step));
	}
	if (info.total > info.values.length)
	{
		return t("for.valuesMore", info.name, info.values.join(", "), info.last, timesText(info.total), String(info.step));
	}
	const text = t("for.values", info.name, info.values.join(", "), timesText(info.total), String(info.step));
	// `for i = 1, 3, 5`: one value, because the step is more than the way to the limit.
	const once = info.total == 1 && info.from != info.to && Math.abs(info.step) > Math.abs(info.to - info.from);
	return once ? text + " " + t("for.bigStep", String(info.step)) : text;
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

module.exports = {
	inCode, innermostBracketAt, planCommaNewLine, inlineSuggestionAt, inlineSuggestionsAt, partialWordAt, finishWord, forSuggestionsAt, findDuplicates, findBracketMismatches,
	NAME_STYLES, namesFor, countIfStyles, chooseIfWord, nearestTable, splitTopLevel, describeNumericFor, forPreviewText,
};
