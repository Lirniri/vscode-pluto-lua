// What happens to the `return` of a function when its return type is taken away: a bare `return` that was only there for the
// type goes, a `return` with a value gets a grey note (what the function returns, its action, "the data type is not set") and
// an offer to remove it. Free of VS Code dependencies so it can be unit-tested.

"use strict";

const { t } = require("./i18n");
const { findFunctionShapes } = require("./hints");

/** The longest value that is shown in the note as it is. */
const SHORT = 30;

const isVoid = (type) => /^void$/i.test(type || "");

/** Whether a type of a header is something a `return` has to give back (not `void`, not nothing). */
const promisesValue = (type) => !!type && !isVoid(type);

/** The type a value of a `return` has, when its form tells: `true` -> `bool`, `"a"` -> `string`, `new Car(1)` -> `Car`. */
function inferType(value)
{
	const v = value.trim().replace(/^\(\s*([^()]*?)\s*\)$/, "$1");
	if (!v)
	{
		return null;
	}
	if (/^(?:true|false)$/.test(v) || /^not\s/.test(v))
	{
		return "bool";
	}
	if (/^nil$/.test(v))
	{
		return "nil";
	}
	if (/^-?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*)$/.test(v) || /^#/.test(v) && !/\s(?:and|or)\s/.test(v))
	{
		return "int";
	}
	if (/^-?(?:\d[\d_]*\.\d*|\.\d+|\d[\d_]*[eE][+-]?\d+)$/.test(v))
	{
		return "float";
	}
	if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(v) || /^(?:"[^"]*"|'[^']*')\s*\.\./.test(v) || /\.\.\s*(?:"[^"]*"|'[^']*')$/.test(v))
	{
		return "string";
	}
	const created = /^new\s+([A-Za-z_][\w.]*)/.exec(v);
	if (created)
	{
		return created[1];
	}
	if (/^\{/.test(v))
	{
		return "table";
	}
	if (/^function\b/.test(v))
	{
		return "function";
	}
	// A comparison with nothing of `and` / `or` around it.
	const bare = v.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "\"\"").replace(/\([^()]*\)/g, "()");
	if (!/\b(?:and|or)\b/.test(bare) && /==|~=|!=|<=|>=|[^<>-][<>][^<>=]/.test(" " + bare + " "))
	{
		return "bool";
	}
	return null;
}

/** What the note says: the type (or a word for "some value"), the action and the closing words. */
function describe(shape, text)
{
	const valued = shape.returns.filter(r => !r.bare);
	const types = [];
	let known = true;
	for (const r of valued)
	{
		const type = inferType(text.slice(r.valueStart, r.valueEnd));
		if (!type)
		{
			known = false;
		}
		else if (!types.includes(type))
		{
			types.push(type);
		}
	}
	const type = known && types.length ? types.join(t("returnHint.or")) : t("returnHint.value");
	let action = t("returnHint.click");
	if (valued.length == 1)
	{
		const value = text.slice(valued[0].valueStart, valued[0].valueEnd);
		if (value.length <= SHORT && !/[\r\n]/.test(value))
		{
			action = value.trim();
		}
	}
	return { type, action, message: t("returnHint.message", type, action) };
}

/** The offsets to delete when a `return` goes: its whole line(s) when nothing else is on them, else only the statement. */
function removalRange(text, ret)
{
	const lineStart = text.lastIndexOf("\n", ret.start - 1) + 1;
	let lineEnd = text.indexOf("\n", ret.end);
	if (lineEnd == -1)
	{
		lineEnd = text.length;
	}
	if (text.slice(lineStart, ret.start).trim() != "" || text.slice(ret.end, lineEnd).trim() != "")
	{
		return { start: ret.start, end: ret.end };
	}
	if (lineEnd < text.length)
	{
		return { start: lineStart, end: lineEnd + 1 };
	}
	// The last line of the text: the break before it goes instead.
	let start = Math.max(0, lineStart - 1);
	if (start > 0 && text[start - 1] == "\r")
	{
		--start;
	}
	return { start, end: lineEnd };
}

/**
 * Looks at the functions after a change. `memory` holds the functions that had a return type that promises a value; when
 * such a function loses its type (the colon is gone, or `void` took its place) the function is reported: a bare `return`
 * goes, a `return` with a value gets the note. A colon that stands there alone is a type being rewritten and changes nothing.
 * @param {ReturnType<typeof import("./hints").findFunctionShapes>} after
 * @param {Set<string>} flagged Functions that have the note now.
 * @param {Set<string>} memory Changed by this call.
 * @returns {{ flagged: Set<string>, removeBare: string[] }}
 */
function track(after, flagged, memory)
{
	const removeBare = [];
	const next = new Set();
	const keys = new Set(after.map(s => s.key));
	for (const k of [...memory])
	{
		if (!keys.has(k))
		{
			memory.delete(k);
		}
	}
	for (const s of after)
	{
		const hasValue = s.returns.some(r => !r.bare);
		const untyped = !s.hasColon && s.retType === null;
		if (promisesValue(s.retType))
		{
			memory.add(s.key);
		}
		else if (s.hasColon && s.retType === null)
		{
			continue; // the type is being rewritten
		}
		else if ((untyped || isVoid(s.retType)) && memory.has(s.key))
		{
			memory.delete(s.key);
			if (s.onlyBareReturn)
			{
				removeBare.push(s.key);
			}
			else if (untyped && hasValue)
			{
				next.add(s.key);
			}
		}
		else if (flagged.has(s.key) && untyped && hasValue)
		{
			next.add(s.key);
		}
	}
	return { flagged: next, removeBare };
}

/**
 * Whether a return type is a usable one: it promises a value and every plain name in it is known.
 * @param {string|null} type
 * @param {(name: string) => boolean} isKnown
 */
function typeIsValid(type, isKnown)
{
	if (!promisesValue(type))
	{
		return false;
	}
	if (/[^\w.?|\s{}()[\],:<>]/.test(type))
	{
		return false;
	}
	for (const name of type.replace(/[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+/g, "").match(/[A-Za-z_]\w*/g) || [])
	{
		if (!isKnown(name))
		{
			return false;
		}
	}
	return !/\.\s*$/.test(type);
}

/**
 * The functions whose body is nothing but a bare `return` and that have no usable return type: the `return` is of no use.
 * @param {ReturnType<typeof findFunctionShapes>} shapes
 * @param {(name: string) => boolean} isKnown
 * @returns {string[]} The keys.
 */
function emptyReturnsWithoutType(shapes, isKnown)
{
	return shapes.filter(s => s.onlyBareReturn && !isVoid(s.retType) && !typeIsValid(s.retType, isKnown)).map(s => s.key);
}

/** `#return = <expression>` on a line of its own. */
const DIRECTIVE = /^[ \t]*#return[ \t]*=[ \t]*(\S.*?)[ \t]*$/;

/** The directive lines of a text: `{ line, expr }`. */
function findDirectives(text)
{
	const out = [];
	text.split("\n").forEach(function (raw, line)
	{
		const m = DIRECTIVE.exec(raw.replace(/\r$/, ""));
		if (m)
		{
			out.push({ line, expr: m[1] });
		}
	});
	return out;
}

/**
 * Carries out the directive on line `dir.line`: the line goes, and its expression becomes the `return` at the end of the function
 * around it (the last statement of the body, when that is a `return`, takes it in; else a new `return` is put before the `end`).
 * @param {string} text
 * @param {{ line: number, expr: string }} dir
 * @param {string} unit One level of indentation.
 * @param {string} eol
 * @returns {string|null} The new text, or null when no function is around the line.
 */
function applyDirective(text, dir, unit, eol)
{
	const shapes = findFunctionShapes(text);
	const owner = shapes.filter(s => s.closeLine < dir.line && dir.line < s.endLine).sort((a, b) => b.closeLine - a.closeLine)[0];
	if (!owner)
	{
		return null;
	}
	const lines = text.split("\n");
	lines.splice(dir.line, 1);
	const without = lines.join("\n");
	const after = findFunctionShapes(without).find(s => s.key == owner.key);
	if (!after)
	{
		return null;
	}
	const lineStart = (n) => lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
	const endText = lines[after.endLine] || "";
	const last = after.returns[after.returns.length - 1];
	if (last && without.slice(last.end, lineStart(after.endLine)).trim() == "")
	{
		return without.slice(0, last.start) + "return " + dir.expr + without.slice(last.end);
	}
	if (endText.trim() != "end")
	{
		return null;
	}
	const headerIndent = /^[ \t]*/.exec(lines[after.closeLine])[0];
	return without.slice(0, lineStart(after.endLine)) + headerIndent + unit + "return " + dir.expr + eol + without.slice(lineStart(after.endLine));
}

/** The smallest single edit that turns `before` into `after`: `{ start, end, text }` over `before`. */
function minimalEdit(before, after)
{
	let start = 0;
	while (start < before.length && start < after.length && before[start] == after[start])
	{
		++start;
	}
	let endB = before.length;
	let endA = after.length;
	while (endB > start && endA > start && before[endB - 1] == after[endA - 1])
	{
		--endB;
		--endA;
	}
	return { start, end: endB, text: after.slice(start, endA) };
}

module.exports = { inferType, describe, removalRange, track, promisesValue, isVoid, SHORT, typeIsValid, emptyReturnsWithoutType, DIRECTIVE, findDirectives, applyDirective, minimalEdit };
