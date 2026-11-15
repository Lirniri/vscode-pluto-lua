// Parameters of a function declaration that have a type but no default value (`function f(test: bool)`), and the
// values that can be given to them (`= false`, `= true`). Free of VS Code dependencies so it can be unit-tested.

"use strict";

const { tokenize } = require("./parser");
const { isParamsParen } = require("./multilineFormat");

const isP = (tok, v) => !!tok && tok.t == "p" && tok.v == v;

/**
 * @typedef {{
 *   name: string, typeText: string, typeStart: number, typeEnd: number, hasDefault: boolean,
 *   paramStart: number, paramEnd: number, line: number
 * }} ParamAtCursor
 *   Offsets are into the text; `typeText` is the type as written (`int?`, `?string`, `int|string`, `{ x: int }`).
 */

/**
 * The parameter of a function declaration the cursor is on, if it has a type: `function f(a, test: bool|, c)`.
 * Only what is on the line of the cursor is looked at, so an unfinished list does not swallow the code below.
 * @param {string} text
 * @param {number} offset Cursor offset.
 * @returns {ParamAtCursor|null}
 */
function paramAt(text, offset)
{
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
	let lineEnd = text.indexOf("\n", offset);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	// Only the brackets matter: find the innermost one that is open at the cursor.
	const tokens = tokenize(text.slice(0, lineEnd));
	const stack = [];
	for (let idx = 0; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (tok.off >= offset && tok.line > 0 && tok.off >= lineStart && !stack.length)
		{
			break;
		}
		if (tok.t != "p")
		{
			continue;
		}
		if (tok.v == "(" || tok.v == "{" || tok.v == "[")
		{
			if (tok.off < offset)
			{
				stack.push({ ch: tok.v, idx });
			}
		}
		else if ((tok.v == ")" || tok.v == "}" || tok.v == "]") && tok.off < offset)
		{
			const open = { ")": "(", "}": "{", "]": "[" }[tok.v];
			for (let k = stack.length - 1; k >= 0; --k)
			{
				if (stack[k].ch == open)
				{
					stack.length = k;
					break;
				}
			}
		}
	}
	const top = stack[stack.length - 1];
	if (!top || top.ch != "(" || !isParamsParen(tokens, top.idx))
	{
		return null;
	}
	// The parameter: from the comma before the cursor to the comma or closer after it (at the depth of the list).
	const open = tokens[top.idx];
	let depth = 0;
	let first = top.idx + 1;
	let last = tokens.length - 1;
	for (let idx = top.idx + 1; idx < tokens.length; ++idx)
	{
		const tok = tokens[idx];
		if (tok.line != open.line && tok.off >= lineStart && tok.off >= offset)
		{
			last = idx - 1;
			break;
		}
		if (tok.t == "p" && (tok.v == "(" || tok.v == "{" || tok.v == "["))
		{
			++depth;
		}
		else if (tok.t == "p" && (tok.v == ")" || tok.v == "}" || tok.v == "]"))
		{
			if (depth == 0)
			{
				last = idx - 1;
				break;
			}
			--depth;
		}
		else if (depth == 0 && isP(tok, ","))
		{
			if (tok.off < offset)
			{
				first = idx + 1;
			}
			else
			{
				last = idx - 1;
				break;
			}
		}
	}
	const span = tokens.slice(first, last + 1).filter(t => t.off >= lineStart && t.off < lineEnd);
	if (!span.length)
	{
		return null;
	}
	// `name: type = default`
	let i = 0;
	if (isP(span[i], "..."))
	{
		++i;
	}
	const nameTok = span[i];
	if (!nameTok || nameTok.t != "id" || !isP(span[i + 1], ":"))
	{
		return null;
	}
	const colon = span[i + 1];
	let typeEndTok = null;
	let typeFirst = null;
	let eq = -1;
	let d = 0;
	for (let k = i + 2; k < span.length; ++k)
	{
		const tok = span[k];
		if (tok.t == "p" && (tok.v == "(" || tok.v == "{" || tok.v == "["))
		{
			++d;
		}
		else if (tok.t == "p" && (tok.v == ")" || tok.v == "}" || tok.v == "]"))
		{
			--d;
		}
		else if (d == 0 && isP(tok, "="))
		{
			eq = k;
			break;
		}
		typeFirst = typeFirst || tok;
		typeEndTok = tok;
	}
	if (!typeFirst || offset < nameTok.off)
	{
		return null;
	}
	const typeEnd = typeEndTok.end;
	return {
		name: nameTok.v,
		typeText: text.slice(typeFirst.off, typeEnd),
		typeStart: typeFirst.off,
		typeEnd,
		hasDefault: eq != -1,
		paramStart: nameTok.off,
		paramEnd: (eq != -1 ? span[span.length - 1].end : typeEnd),
		line: nameTok.line,
	};
}

/** Values that make sense as a default of a built-in type, most useful first. */
const VALUES = {
	bool: ["false", "true"],
	boolean: ["false", "true"],
	int: ["0", "1", "-1"],
	integer: ["0", "1", "-1"],
	number: ["0", "1", "-1"],
	float: ["0.0", "1.0", "-1.0"],
	string: ["\"\""],
	table: ["{}"],
	function: ["function() end"],
	userdata: [],
	any: ["nil", "false", "0", "\"\"", "{}"],
	mixed: ["nil", "false", "0", "\"\"", "{}"],
	nil: ["nil"],
	void: [],
};

/**
 * Splits a type at the `|` of its top level: `int|string?` → [`int`, `string?`].
 * @param {string} typeText
 */
function splitUnion(typeText)
{
	const parts = [];
	let depth = 0;
	let current = "";
	for (const c of typeText)
	{
		if (c == "(" || c == "{" || c == "[")
		{
			++depth;
		}
		else if (c == ")" || c == "}" || c == "]")
		{
			--depth;
		}
		if (c == "|" && depth == 0)
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
	return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Whether every part of a type is a type this extension knows: a built-in one, a class, or a table type.
 * @param {string} typeText
 * @param {(name: string) => boolean} isClass
 */
function isCompleteType(typeText, isClass)
{
	if (/\|\s*$/.test(typeText) || /^\s*\|/.test(typeText))
	{
		return false; // `int|`: another member is coming
	}
	const parts = splitUnion(typeText);
	return parts.length > 0 && parts.every(function (part)
	{
		const base = part.replace(/^\?/, "").replace(/\?$/, "");
		return base == "nil" || Object.prototype.hasOwnProperty.call(VALUES, base) || /^\{.*\}$/.test(base) || /^function\s*\(.*$/.test(base) || (/^[A-Za-z_][\w.]*$/.test(base) && !!isClass && isClass(base));
	});
}

/**
 * The values that can be given to a parameter of this type as its default, most useful first.
 * @param {string} typeText `bool`, `int?`, `?string`, `int|string`, `Vehicle`, `{ x: int }`
 * @param {(name: string) => boolean} [isClass] Whether a name is a class (so `Vehicle` offers `new Vehicle()`).
 * @returns {string[]}
 */
function defaultValuesFor(typeText, isClass)
{
	const out = [];
	let nullable = false;
	const add = (v) => { if (!out.includes(v)) { out.push(v); } };
	for (const part of splitUnion(typeText))
	{
		const base = part.replace(/^\?/, "").replace(/\?$/, "");
		nullable = nullable || part != base;
		if (Object.prototype.hasOwnProperty.call(VALUES, base))
		{
			for (const v of VALUES[base])
			{
				add(v);
			}
			nullable = nullable || base == "nil";
		}
		else if (/^\{.*\}$/.test(base))
		{
			add("{}");
		}
		else if (/^function\s*\(/.test(base))
		{
			add("function() end");
		}
		else if (isClass && isClass(base))
		{
			add("new " + base + "()");
		}
	}
	if (nullable)
	{
		// `nil` first would push the real values down: a nullable parameter is mostly given a value.
		add("nil");
	}
	return out;
}

module.exports = { paramAt, splitUnion, isCompleteType, defaultValuesFor, VALUES };
