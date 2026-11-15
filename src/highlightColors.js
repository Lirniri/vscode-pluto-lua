// User-defined colors of the syntax highlighting. The settings are turned into TextMate rules that are
// kept in `editor.tokenColorCustomizations` under names starting with "Pluto: ", so the rules of the
// user are never touched. The conversion is free of VS Code dependencies so it can be unit-tested.

"use strict";

const RULE_PREFIX = "Pluto: ";

// Setting key (pluto.highlight.colors.<key>) -> grammar scopes it colors.
const CATEGORIES = {
	functionName: ["entity.name.function.pluto"],
	functionKeyword: ["storage.type.function.pluto", "storage.type.function.arrow.pluto"],
	parameter: ["variable.parameter.function.pluto"],
	type: ["storage.type.primitive.pluto", "storage.type.named.pluto", "meta.type.named.pluto"],
	returnType: ["meta.return-type.pluto storage.type.primitive.pluto"],
	typeColon: ["meta.typehint.pluto punctuation.separator.colon.pluto"],
	keyword: ["keyword.control.pluto"],
	operator: ["keyword.operator.logical.pluto", "keyword.operator.assignment.pluto", "keyword.operator.pluto", "keyword.operator.ternary.pluto"],
	constant: ["constant.language.pluto"],
	modifier: ["storage.modifier.pluto", "storage.modifier.access.pluto"],
	accessor: ["punctuation.accessor.pluto"],
};

// Brackets of nested tables: the colors repeat by depth, up to this many levels are told apart
// (deeper ones take the color of the last level).
const MAX_TABLE_DEPTH = 8;

/**
 * Whether a color is fully transparent (`#0000`, `#00000000`): text in it would be invisible.
 * @param {string} color A `#RGB`, `#RGBA`, `#RRGGBB` or `#RRGGBBAA` color.
 */
function isInvisibleColor(color)
{
	return (color.length == 5 && color[4] == "0") || (color.length == 9 && color.slice(7) == "00");
}

/**
 * Checks a style and says what is wrong with it, so that a mistake can be reported and the color of the
 * theme stays instead of a wrong one.
 * @param {unknown} value "#ff8800 bold italic" or { color, fontStyle }.
 * @returns {{ settings: { foreground?: string, fontStyle?: string }|null, problem?: "invalid"|"transparent" }}
 *   `settings` is null when nothing usable is left; an empty value is "not set" and no problem.
 */
function checkStyle(value)
{
	if (value && typeof value == "object" && !Array.isArray(value))
	{
		// { "color": "#FF8800", "fontStyle": "bold" }, as written with the color picker.
		value = [value.color, value.fontStyle].filter(v => typeof v == "string" && v.trim()).join(" ");
	}
	if (value === undefined || value === null || value === "")
	{
		return { settings: null };
	}
	if (typeof value != "string")
	{
		return { settings: null, problem: "invalid" };
	}
	const settings = {};
	const fontStyle = [];
	for (const word of value.trim().split(/\s+/))
	{
		if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(word))
		{
			if (isInvisibleColor(word))
			{
				return { settings: null, problem: "transparent" };
			}
			settings.foreground = word;
		}
		else if (/^(?:bold|italic|underline|strikethrough)$/i.test(word))
		{
			if (!fontStyle.includes(word.toLowerCase()))
			{
				fontStyle.push(word.toLowerCase());
			}
		}
		else if (/^(?:normal|none)$/i.test(word))
		{
			settings.fontStyle = "";
		}
		else if (word)
		{
			return { settings: null, problem: "invalid" }; // a typo must not turn into some other color
		}
	}
	if (fontStyle.length)
	{
		settings.fontStyle = fontStyle.join(" ");
	}
	return Object.keys(settings).length ? { settings } : { settings: null };
}

/**
 * Parses "#ff8800 bold italic" (or { color, fontStyle }) into a TextMate settings object.
 * @param {unknown} value A color string, optionally followed by bold / italic / underline / strikethrough.
 * @returns {{ foreground?: string, fontStyle?: string }|null} null when there is nothing usable or the
 *   value is wrong (a typo, a fully transparent color).
 */
function parseStyle(value)
{
	return checkStyle(value).settings;
}

/**
 * What is wrong in the settings: unknown keys, values that are not colors, fully transparent colors.
 * @param {Record<string, unknown>|undefined} colors Value of `pluto.highlight.colors`.
 * @param {unknown[]|undefined} tableBrackets Value of `pluto.highlight.tableBracketColors`.
 * @returns {{ name: string, value: string, problem: "invalid"|"transparent"|"unknownKey" }[]}
 */
function findProblems(colors, tableBrackets)
{
	const problems = [];
	const show = (value) => typeof value == "string" ? value : JSON.stringify(value);
	if (colors && typeof colors == "object")
	{
		for (const [key, value] of Object.entries(colors))
		{
			if (!(key in CATEGORIES))
			{
				problems.push({ name: key, value: show(value), problem: "unknownKey" });
				continue;
			}
			const { problem } = checkStyle(value);
			if (problem)
			{
				problems.push({ name: "colors." + key, value: show(value), problem });
			}
		}
	}
	(Array.isArray(tableBrackets) ? tableBrackets : []).forEach(function (value, i)
	{
		const { problem } = checkStyle(value);
		if (problem)
		{
			problems.push({ name: "tableBracketColors[" + i + "]", value: show(value), problem });
		}
	});
	return problems;
}

/**
 * The TextMate rules for the settings.
 * @param {Record<string, unknown>|undefined} colors Value of `pluto.highlight.colors`.
 * @param {unknown[]|undefined} tableBrackets Value of `pluto.highlight.tableBracketColors`.
 * @returns {{ name: string, scope: string[], settings: object }[]}
 */
function buildRules(colors, tableBrackets)
{
	const rules = [];
	for (const [key, scopes] of Object.entries(CATEGORIES))
	{
		const settings = parseStyle(colors && colors[key]);
		if (settings)
		{
			rules.push({ name: RULE_PREFIX + key, scope: scopes.slice(), settings });
		}
	}
	const palette = (Array.isArray(tableBrackets) ? tableBrackets : []).map(parseStyle).filter(Boolean);
	if (palette.length)
	{
		// A `{` at depth N has N `meta.table.pluto` scopes, so a descendant selector picks the level.
		for (let depth = 1; depth <= MAX_TABLE_DEPTH; ++depth)
		{
			const path = "meta.table.pluto ".repeat(depth);
			rules.push({
				name: RULE_PREFIX + "tableBracket " + depth,
				scope: [path + "punctuation.section.table.begin.pluto", path + "punctuation.section.table.end.pluto"],
				settings: palette[(depth - 1) % palette.length],
			});
		}
	}
	return rules;
}

/**
 * Replaces the rules this extension manages in a list of textMateRules and leaves the others as they are.
 * @param {any[]|undefined} existing
 * @param {{ name: string }[]} rules
 */
function mergeRules(existing, rules)
{
	const others = (Array.isArray(existing) ? existing : []).filter(r => !(r && typeof r.name == "string" && r.name.startsWith(RULE_PREFIX)));
	return others.concat(rules);
}

module.exports = { RULE_PREFIX, CATEGORIES, MAX_TABLE_DEPTH, parseStyle, checkStyle, isInvisibleColor, findProblems, buildRules, mergeRules };
