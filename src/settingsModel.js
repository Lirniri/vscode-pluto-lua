// The settings of the extension as the panel with tabs shows them: which tab a setting belongs to, what control it
// gets, and whether a value the panel wants to save is allowed. Free of VS Code dependencies so it can be unit-tested.

"use strict";

const { checkStyle, findProblems, CATEGORIES } = require("./highlightColors");
const { t } = require("./i18n");

/** The tabs, in order. A setting that no tab claims lands on the first one, so a new setting is never lost. */
const TABS = [
	{ id: "general", match: (k) => k == "plua.language" || k == "plua.autoCloseBlocks" || /^plua\.quickDeleteEnd/.test(k) || k == "plua.shiftDeleteByPieces" || k == "plua.shiftBackspaceDeleteFromBelow.enabled" || k == "plua.shiftDeleteFromNextLine" || k == "plua.lua.enable" || k == "plua.lua.indexFiles" },
	{ id: "index", match: (k) => /^plua.(?:index|workspace)\./.test(k) },
	{ id: "compilers", match: (k) => /^plua\.compilers\./.test(k) || k == "plua.lua.compilerPath" || k == "plua.lua.checkSyntax" || k == "plua.diagnostics.compilerPath" },
	{ id: "autoIndent", match: (k) => /^plua\.autoIndent\./.test(k) },
	{ id: "layout", match: (k) => /^plua\.layoutFixer\./.test(k) },
	{ id: "completion", match: (k) => /^plua\.completion\./.test(k) },
	{ id: "hover", match: (k) => /^plua\.hover\./.test(k) },
	{ id: "outline", match: (k) => /^plua\.outline\./.test(k) },
	{ id: "diagnostics", match: (k) => /^plua\.diagnostics\./.test(k) },
	{ id: "highlight", match: (k) => /^plua\.highlight\./.test(k) },
	{ id: "typing", match: (k) => /^plua\.format\./.test(k) },
	{ id: "json", match: (k) => /^plua\.json\./.test(k) },
];

const FONT_STYLES = ["", "normal", "bold", "italic", "bold italic", "underline", "bold underline", "italic underline"];
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** @param {string} key */
function tabOf(key)
{
	const tab = TABS.find(t => t.match(key));
	return tab ? tab.id : TABS[0].id;
}

/** `%some.key%` of a manifest → its text from the nls file. */
function resolveText(text, nls)
{
	if (typeof text != "string")
	{
		return "";
	}
	const m = /^%(.+)%$/.exec(text);
	return m && nls && nls[m[1]] !== undefined ? nls[m[1]] : text;
}

/**
 * What control a setting gets.
 * @param {string} key
 * @param {any} prop Its entry in `contributes.configuration.properties`.
 * @returns {"boolean"|"enum"|"color"|"text"|"number"|"list"|"colors"|"bracketColors"|"map"|"json"}
 */
function kindOf(key, prop)
{
	if (key == "plua.highlight.colors")
	{
		return "colors";
	}
	if (key == "plua.highlight.tableBracketColors")
	{
		return "bracketColors";
	}
	if (key == "plua.compilers.list")
	{
		return "compilers";
	}
	if (Array.isArray(prop.enum))
	{
		return "enum";
	}
	const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
	if (type == "boolean")
	{
		return "boolean";
	}
	if (type == "integer" || type == "number")
	{
		return "number";
	}
	if (type == "string")
	{
		return prop.format == "color-hex" ? "color" : "text";
	}
	if (type == "array" && prop.items && prop.items.type == "string")
	{
		return "list";
	}
	if (type == "object" && prop.properties && Object.values(prop.properties).every(p => p.type == "string"))
	{
		return "map";
	}
	return "json";
}

/**
 * Builds what the panel shows.
 * @param {any} pkg The manifest (package.json).
 * @param {Record<string, string>} nls Texts of the language in use.
 * @param {(key: string) => unknown} valueOf The value a setting has now.
 * @param {Record<string, string>} tabTitles Title of each tab, by id.
 */
function buildModel(pkg, nls, valueOf, tabTitles)
{
	const props = pkg.contributes.configuration.properties;
	const tabs = TABS.map(t => ({ id: t.id, title: tabTitles[t.id] || t.id, items: [] }));
	for (const [key, prop] of Object.entries(props))
	{
		if (prop.deprecationMessage || prop.markdownDeprecationMessage)
		{
			continue; // old names are not for the panel
		}
		const kind = kindOf(key, prop);
		const item = {
			key,
			kind,
			title: key.replace(/^plua./, ""),
			description: resolveText(prop.markdownDescription || prop.description, nls),
			value: valueOf(key),
			default: prop.default,
		};
		if (kind == "enum")
		{
			item.options = prop.enum.map((value, i) => ({ value, label: prop.enumDescriptions ? resolveText(prop.enumDescriptions[i], nls) : String(value) }));
		}
		if (kind == "number")
		{
			item.min = prop.minimum;
			item.max = prop.maximum;
			item.integer = prop.type == "integer";
		}
		if (kind == "colors")
		{
			item.categories = Object.keys(prop.properties).map(name => ({ name, description: resolveText(prop.properties[name].markdownDescription, nls) }));
			item.fontStyles = FONT_STYLES;
		}
		if (kind == "bracketColors")
		{
			item.fontStyles = FONT_STYLES;
		}
		if (kind == "map")
		{
			item.fields = Object.keys(prop.properties);
		}
		tabs[TABS.findIndex(t => t.id == tabOf(key))].items.push(item);
	}
	return { tabs: tabs.filter(t => t.items.length) };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the panel may save a value, and what is saved (the cleaned value).
 * @param {any} pkg
 * @param {string} key
 * @param {unknown} value
 * @returns {{ ok: true, value: unknown, isDefault: boolean }|{ ok: false, error: string }}
 */
function validateChange(pkg, key, value)
{
	const props = pkg.contributes.configuration.properties;
	const prop = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null;
	if (!prop || !key.startsWith("plua."))
	{
		return { ok: false, error: t("settings.err.unknown") };
	}
	const kind = kindOf(key, prop);
	const result = (v) => ({ ok: true, value: v, isDefault: same(v, prop.default) });
	if (key == "plua.layoutFixer.sourceLayouts")
	{
		if (!Array.isArray(value) || value.some(v => !["ru", "uk", "be"].includes(v)))
		{
			return { ok: false, error: t("settings.err.layouts") };
		}
		return result(Array.from(new Set(value)));
	}
	if (key == "plua.layoutFixer.customMap")
	{
		if (!value || typeof value != "object" || Array.isArray(value)
			|| Object.entries(value).some(([k, v]) => Array.from(k).length != 1 || typeof v != "string" || Array.from(v).length > 4))
		{
			return { ok: false, error: t("settings.err.customMap") };
		}
		return result(value);
	}
	switch (kind)
	{
		case "boolean":
			return typeof value == "boolean" ? result(value) : { ok: false, error: t("settings.err.bool") };
		case "enum":
			return prop.enum.includes(value) ? result(value) : { ok: false, error: t("settings.err.choice") };
		case "color":
			if (typeof value != "string")
			{
				return { ok: false, error: t("settings.err.color") };
			}
			return value.trim() == "" ? result(prop.default) : (HEX.test(value.trim()) ? result(value.trim()) : { ok: false, error: t("settings.err.hex") });
		case "text":
			return typeof value == "string" ? result(value) : { ok: false, error: t("settings.err.text") };
		case "number":
		{
			const n = typeof value == "number" ? value : Number(value);
			if (!Number.isFinite(n) || (prop.minimum !== undefined && n < prop.minimum) || (prop.maximum !== undefined && n > prop.maximum))
			{
				return { ok: false, error: prop.minimum !== undefined && prop.maximum !== undefined ? t("settings.err.numberRange", prop.minimum, prop.maximum) : (prop.minimum !== undefined ? t("settings.err.numberFrom", prop.minimum) : t("settings.err.number")) };
			}
			return result(prop.type == "integer" ? Math.round(n) : n);
		}
		case "list":
		{
			if (!Array.isArray(value) || value.some(v => typeof v != "string"))
			{
				return { ok: false, error: t("settings.err.list") };
			}
			return result(value.map(v => v.trim()).filter(Boolean));
		}
		case "compilers":
			return cleanCompilers(value, result);
		case "colors":
		{
			if (!value || typeof value != "object" || Array.isArray(value))
			{
				return { ok: false, error: t("settings.err.object") };
			}
			const clean = {};
			for (const name of Object.keys(CATEGORIES))
			{
				if (value[name] !== undefined && value[name] !== null)
				{
					const v = cleanStyle(value[name]);
					if (v)
					{
						clean[name] = v;
					}
				}
			}
			if (Object.keys(value).some(k => !(k in CATEGORIES)) || findProblems(clean, []).length)
			{
				return { ok: false, error: t("settings.err.style") };
			}
			return result(clean);
		}
		case "bracketColors":
		{
			if (!Array.isArray(value))
			{
				return { ok: false, error: t("settings.err.array") };
			}
			const clean = value.map(cleanStyle).filter(Boolean);
			if (findProblems({}, clean).length)
			{
				return { ok: false, error: t("settings.err.style") };
			}
			return result(clean);
		}
		case "map":
		{
			if (!value || typeof value != "object" || Array.isArray(value))
			{
				return { ok: false, error: t("settings.err.object") };
			}
			const clean = {};
			for (const k of Object.keys(prop.properties))
			{
				const v = value[k];
				if (typeof v == "string" && v.trim())
				{
					if (prop.properties[k].pattern && !new RegExp(prop.properties[k].pattern).test(v.trim()))
					{
						return { ok: false, error: t("settings.err.name", v) };
					}
					clean[k] = v.trim();
				}
			}
			return Object.keys(value).some(k => !(k in prop.properties)) ? { ok: false, error: t("settings.err.field") } : result(clean);
		}
		default:
			return value !== undefined ? result(value) : { ok: false, error: t("settings.err.novalue") };
	}
}

/** The most a path of an interpreter may be. */
const MAX_COMPILER_PATH = 1024;

/**
 * The list of interpreters: `{ language: "pluto"|"lua", path }`. A path is a program that will be started, so it must be a
 * single line without control characters or quotes/shell operators; empty paths are dropped, equal entries merged.
 */
function cleanCompilers(value, result)
{
	if (!Array.isArray(value))
	{
		return { ok: false, error: t("settings.err.array") };
	}
	const clean = [];
	for (const entry of value)
	{
		if (!entry || typeof entry != "object" || Array.isArray(entry) || Object.keys(entry).some(k => k != "language" && k != "path"))
		{
			return { ok: false, error: t("settings.err.field") };
		}
		if (entry.language !== "pluto" && entry.language !== "lua")
		{
			return { ok: false, error: t("settings.err.choice") };
		}
		const p = typeof entry.path == "string" ? entry.path.trim() : null;
		if (p === null)
		{
			return { ok: false, error: t("settings.err.text") };
		}
		if (!p)
		{
			continue;
		}
		if (p.length > MAX_COMPILER_PATH || /["<>|&;`]/.test(p) || Array.from(p).some(ch => ch.charCodeAt(0) < 32))
		{
			return { ok: false, error: t("settings.err.compilerPath") };
		}
		if (!clean.some(c => c.language == entry.language && c.path == p))
		{
			clean.push({ language: entry.language, path: p });
		}
	}
	return result(clean);
}

/** A style of the panel: an object with `color`, `darkColor`, `lightColor`, `fontStyle`, or a short string. Empty parts are dropped. */
function cleanStyle(value)
{
	if (typeof value == "string")
	{
		return value.trim() ? value.trim() : null;
	}
	if (!value || typeof value != "object" || Array.isArray(value))
	{
		return null;
	}
	const out = {};
	for (const field of ["color", "darkColor", "lightColor", "fontStyle"])
	{
		if (typeof value[field] == "string" && value[field].trim())
		{
			out[field] = value[field].trim();
		}
	}
	return Object.keys(out).length ? out : null;
}

/** Whether a style of the panel is valid (a bad one makes `checkStyle` say so). */
function styleProblem(value)
{
	return checkStyle(value).problem || null;
}

module.exports = { TABS, FONT_STYLES, HEX, tabOf, resolveText, kindOf, buildModel, validateChange, cleanStyle, styleProblem, cleanCompilers };
