// Checks the strings of a JSON file that look like paths of files: `"entry": "src/main.pluto"`. A string is a
// path when it ends with one of the known extensions (`.pluto` and `.lua`, or every extension found in the
// folder of the project). Free of VS Code dependencies so it can be unit-tested with plain Node.

"use strict";

const path = require("path");
const { t } = require("./i18n");

/**
 * @typedef {{ value: string, start: number, end: number, key: string|null }} JsonString
 *   `start` / `end` are offsets of the string including its quotes; `key` is the name of the property the
 *   string is the value of (for array items: the property of the array).
 */

/**
 * The string values of a JSON text (comments are tolerated, so `settings.json` works too). Keys are left out.
 * @param {string} text
 * @returns {JsonString[]}
 */
function scanStrings(text)
{
	const out = [];
	/** @type {{ type: "obj"|"arr", key: string|null, expectKey: boolean }[]} */
	const stack = [];
	let i = 0;
	while (i < text.length)
	{
		const c = text[i];
		if (c == "/" && text[i + 1] == "/")
		{
			while (i < text.length && text[i] != "\n")
			{
				++i;
			}
		}
		else if (c == "/" && text[i + 1] == "*")
		{
			const end = text.indexOf("*/", i + 2);
			i = end == -1 ? text.length : end + 2;
		}
		else if (c == "\"")
		{
			let j = i + 1;
			while (j < text.length && text[j] != "\"" && text[j] != "\n")
			{
				j += text[j] == "\\" ? 2 : 1;
			}
			const end = Math.min(text.length, j + 1);
			const raw = text.slice(i, end);
			const top = stack[stack.length - 1];
			let value = raw.slice(1, -1);
			try
			{
				value = JSON.parse(raw);
			}
			catch (e)
			{
				// an unfinished string: use it as it is
			}
			if (top && top.type == "obj" && top.expectKey)
			{
				top.key = value;
				top.expectKey = false;
			}
			else if (text[j] == "\"")
			{
				out.push({ value, start: i, end, key: top ? top.key : null });
			}
			i = end;
		}
		else
		{
			const top = stack[stack.length - 1];
			if (c == "{")
			{
				stack.push({ type: "obj", key: top ? top.key : null, expectKey: true });
			}
			else if (c == "[")
			{
				stack.push({ type: "arr", key: top ? top.key : null, expectKey: false });
			}
			else if (c == "}" || c == "]")
			{
				stack.pop();
			}
			else if (c == "," && top && top.type == "obj")
			{
				top.expectKey = true;
			}
			++i;
		}
	}
	return out;
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|data:|about:)/i;

/** The lower-case extension (with the dot) of a file name, or "". */
function extensionOf(name)
{
	const m = /\.([A-Za-z0-9_+-]{1,10})$/.exec(name);
	return m ? "." + m[1].toLowerCase() : "";
}

/**
 * Whether a JSON string looks like the path of a file with one of the known extensions: no URL, no glob or
 * regular expression, no sentence.
 * @param {string} value
 * @param {Set<string>} extensions Lower-case extensions with the dot, e.g. `.lua`.
 */
function looksLikePath(value, extensions)
{
	if (!value || value.length > 300 || /[\r\n\t]/.test(value) || URL_LIKE.test(value) || /[*?<>|"{}$^]/.test(value))
	{
		return false;
	}
	if (value != value.trim() || (/\s/.test(value) && !/[\\/]/.test(value)))
	{
		return false; // a sentence such as "see foo.lua", not a path
	}
	const name = value.replace(/\\/g, "/").split("/").pop();
	return !!name && name != "." && name != ".." && extensions.has(extensionOf(name));
}

const posix = (p) => p.replace(/\\/g, "/");
const isAbsolute = (p) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/**
 * Where a path written in a JSON file may point: next to the JSON file, and relative to each folder of the workspace.
 * @param {string} value
 * @param {string} jsonDir Folder of the JSON file.
 * @param {string[]} roots Workspace folders.
 */
function pathCandidates(value, jsonDir, roots)
{
	const v = posix(value);
	if (isAbsolute(v))
	{
		return [path.posix.normalize(v)];
	}
	const out = [];
	for (const base of [jsonDir, ...roots])
	{
		const full = path.posix.normalize(posix(base).replace(/\/+$/, "") + "/" + v);
		if (!out.includes(full))
		{
			out.push(full);
		}
	}
	return out;
}

/**
 * Files of the project with the name of a missing one, nearest to the JSON file first: the file was probably
 * moved or renamed.
 * @param {string} value The path as written.
 * @param {string} jsonDir
 * @param {Map<string, string[]>} byName Known files by lower-case name.
 * @returns {string[]} Paths relative to `jsonDir`, with `/`.
 */
function suggestionsFor(value, jsonDir, byName)
{
	const wanted = posix(value).replace(/^(?:\.\.?\/)+/, "");
	const name = wanted.split("/").pop().toLowerCase();
	const found = byName.get(name) || [];
	const dir = posix(jsonDir).replace(/\/+$/, "");
	const score = function (file)
	{
		// Longer common ending with the written path first, then the nearest folder.
		const a = wanted.toLowerCase().split("/").reverse();
		const b = file.toLowerCase().split("/").reverse();
		let same = 0;
		while (same < a.length && same < b.length && a[same] == b[same])
		{
			++same;
		}
		const parts = file.split("/");
		const base = dir.split("/");
		let common = 0;
		while (common < parts.length && common < base.length && parts[common].toLowerCase() == base[common].toLowerCase())
		{
			++common;
		}
		return [same, -(parts.length - common + base.length - common)];
	};
	return found
		.slice()
		.sort((x, y) =>
		{
			const sx = score(x);
			const sy = score(y);
			return (sy[0] - sx[0]) || (sy[1] - sx[1]) || x.localeCompare(y);
		})
		.slice(0, 3)
		.map(file => path.posix.relative(dir, file) || path.posix.basename(file));
}

/**
 * Groups file paths by lower-case file name.
 * @param {string[]} files
 */
function indexByName(files)
{
	const map = new Map();
	for (const file of files)
	{
		const f = posix(file);
		const name = f.split("/").pop().toLowerCase();
		const list = map.get(name);
		if (list)
		{
			list.push(f);
		}
		else
		{
			map.set(name, [f]);
		}
	}
	return map;
}

/**
 * Positions of an offset range in a text.
 */
function positionAt(text, offset)
{
	let line = 0;
	let lineStart = 0;
	for (let i = 0; i < offset && i < text.length; ++i)
	{
		if (text.charCodeAt(i) == 10)
		{
			++line;
			lineStart = i + 1;
		}
	}
	return { line, col: offset - lineStart };
}

/**
 * @typedef {{ line: number, col: number, endLine: number, endCol: number, severity: string, message: string, code: string, value: string, suggestions: string[], start: number, end: number }} JsonPathProblem
 */

/**
 * Checks the paths in a JSON text.
 * @param {string} text
 * @param {string} jsonPath File system path of the JSON file.
 * @param {{
 *   exists: (path: string) => boolean,
 *   roots?: string[],
 *   files?: string[],
 *   extensions: Set<string>,
 *   skipKeys?: Set<string>,
 *   severity?: "error"|"warning"|"information",
 * }} ctx `exists`: whether a file or folder exists; `roots`: workspace folders; `files`: the files of the
 *   project, to offer a moved file; `extensions`: lower-case extensions (with the dot) that are checked;
 *   `skipKeys`: properties that are checked elsewhere (`entry` / `main` of a manifest).
 * @returns {JsonPathProblem[]}
 */
function lintJsonPaths(text, jsonPath, ctx)
{
	const out = [];
	const jsonDir = path.posix.dirname(posix(jsonPath));
	const roots = ctx.roots || [];
	const byName = indexByName(ctx.files || []);
	const seen = new Map();
	for (const s of scanStrings(text))
	{
		if (ctx.skipKeys && s.key !== null && ctx.skipKeys.has(s.key))
		{
			continue;
		}
		if (!looksLikePath(s.value, ctx.extensions))
		{
			continue;
		}
		let known = seen.get(s.value);
		if (known === undefined)
		{
			known = pathCandidates(s.value, jsonDir, roots).some(p => ctx.exists(p));
			seen.set(s.value, known);
		}
		if (known)
		{
			continue;
		}
		const suggestions = suggestionsFor(s.value, jsonDir, byName);
		const a = positionAt(text, s.start);
		const b = positionAt(text, s.end);
		out.push({
			line: a.line, col: a.col, endLine: b.line, endCol: b.col,
			severity: ctx.severity || "warning",
			message: suggestions.length
				? t("json.pathMissingMoved", s.value, suggestions[0])
				: t(roots.length ? "json.pathMissing" : "json.pathMissingNoFolder", s.value),
			code: "json-path",
			value: s.value,
			suggestions,
			start: s.start,
			end: s.end,
		});
	}
	return out;
}

module.exports = { scanStrings, looksLikePath, extensionOf, pathCandidates, suggestionsFor, indexByName, lintJsonPaths };
