// What happens to the `return` of a function when its return type is taken away: a bare `return` that was only there for the
// type goes, a `return` with a value gets a grey note (what the function returns, its action, "the data type is not set") and
// an offer to remove it. Free of VS Code dependencies so it can be unit-tested.

"use strict";

const { t } = require("./i18n");

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

module.exports = { inferType, describe, removalRange, track, promisesValue, isVoid, SHORT };
