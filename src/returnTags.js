// `@return` tags written by developers, both in the comments above a function and inside of its body:
//   --- @return bool Whether the vehicle exists
//   -- @return Description without a type
// Free of VS Code dependencies so it can be unit-tested with plain Node.

"use strict";

const DOC_TAG = /^\s*@returns?\b[:\s]*(.*?)\s*$/i;
const COMMENT_TAG = /^\s*-{2,}\s*@returns?\b[:\s]*(.*?)\s*$/i;
const TRAILING_TAG = /\s--+\s*@returns?\b[:\s]*(.*?)\s*$/i;

/** Lower-cased alternatives of a type: `?string|nil` → ["string", "nil"]. */
function typeParts(type)
{
	return String(type || "").toLowerCase().split("|").map(s => s.replace(/[?\s]/g, "")).filter(Boolean);
}

/**
 * Splits the text after `@return` into an optional type and the developer's description.
 * The first word counts as a type if it is a built-in type or the function's declared return type;
 * otherwise everything is the description (`@return Description`).
 * @param {string} content
 * @param {string} [declared] The return type written in the function's signature.
 * @param {(name: string) => boolean} isBuiltinType
 * @returns {{ type: string|null, text: string }}
 */
function splitReturnTag(content, declared, isBuiltinType)
{
	const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(content);
	if (!m)
	{
		return { type: null, text: "" };
	}
	const known = new Set(typeParts(declared));
	const parts = typeParts(m[1]);
	// A lone `nil` starts a sentence (`@return nil when it can't be told`) rather than naming a type.
	if (parts.length && parts.every(p => known.has(p) || isBuiltinType(p)) && parts.some(p => p != "nil"))
	{
		return { type: m[1], text: (m[2] || "").replace(/^[-–—:]\s+/, "").trim() };
	}
	return { type: null, text: content.replace(/^[-–—:]\s+/, "").trim() };
}

/**
 * All `@return` tags of a function.
 * @param {{ doc?: string, line: number, endLine: number, returnType?: string }} sym
 * @param {string[]} lines Lines of the file the function is declared in.
 * @param {{ line: number, endLine: number }[]} nested Functions declared inside of it; their comments belong to them.
 * @param {(name: string) => boolean} isBuiltinType
 * @returns {{ source: "doc"|"body", raw: string, type: string|null, text: string }[]}
 */
function collectReturnTags(sym, lines, nested, isBuiltinType)
{
	const tags = [];
	const add = function (source, content)
	{
		const { type, text } = splitReturnTag(content, sym.returnType, isBuiltinType);
		if (type || text)
		{
			tags.push({ source, raw: "@return " + content, type, text });
		}
	};
	for (const line of (sym.doc || "").split("\n"))
	{
		const m = DOC_TAG.exec(line);
		if (m)
		{
			add("doc", m[1]);
		}
	}
	const last = Math.min(sym.endLine, lines.length - 1);
	for (let l = sym.line; l <= last; ++l)
	{
		if (l > sym.line && nested.some(n => l >= n.line && l <= n.endLine))
		{
			continue;
		}
		const m = COMMENT_TAG.exec(lines[l]) || (l == sym.line ? TRAILING_TAG.exec(lines[l]) : null);
		if (m)
		{
			add("body", m[1]);
		}
	}
	return tags;
}

/**
 * The description that belongs to a return type the cursor is on.
 * @param {{ type: string|null, text: string }[]} tags
 * @param {string} word The type under the cursor.
 * @returns {string|null}
 */
function describeReturnType(tags, word)
{
	const candidates = tags.filter(t => t.text);
	const w = word.toLowerCase();
	const exact = candidates.find(t => t.type && typeParts(t.type).includes(w));
	const chosen = exact || (candidates.length == 1 ? candidates[0] : candidates.find(t => !t.type));
	return chosen ? chosen.text : null;
}

module.exports = { collectReturnTags, splitReturnTag, describeReturnType, typeParts };
