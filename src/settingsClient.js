// The script that runs inside of the settings panel (a webview). It is not loaded as a module: ./settingsPanel reads
// this file and puts it in the page. Everything is built with DOM calls and `textContent`, so no text of a setting is
// ever taken for HTML.

"use strict";

(function ()
{
	const vscode = acquireVsCodeApi();
	const raw = document.getElementById("data").textContent.trim();
	const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))));
	const S = data.strings;
	const model = data.model;
	const saved = vscode.getState() || {};
	let activeTab = saved.tab && model.tabs.some(t => t.id == saved.tab) ? saved.tab : model.tabs[0].id;
	let query = saved.query || "";
	const itemByKey = new Map();
	for (const tab of model.tabs)
	{
		for (const item of tab.items)
		{
			itemByKey.set(item.key, item);
		}
	}

	const $ = (sel, root) => (root || document).querySelector(sel);

	function el(tag, props, ...children)
	{
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(props || {}))
		{
			if (k == "class")
			{
				e.className = v;
			}
			else if (k.startsWith("on"))
			{
				e.addEventListener(k.slice(2), v);
			}
			else if (v !== undefined && v !== null && v !== false)
			{
				e.setAttribute(k, v === true ? "" : v);
			}
		}
		for (const c of children.flat())
		{
			if (c !== null && c !== undefined)
			{
				e.append(c.nodeType ? c : document.createTextNode(String(c)));
			}
		}
		return e;
	}

	// `code` in the descriptions
	function richText(text)
	{
		const out = el("div", { class: "desc" });
		String(text || "").split(/\n\n+/).forEach(function (par)
		{
			const p = el("p");
			// `#plua.some.setting#` is how the standard settings editor links to a setting; here it is just the name.
			par.split("`").forEach((piece, i) => p.append(i % 2 ? el("code", {}, piece.replace(/^#([\w.]+)#$/, "$1")) : document.createTextNode(piece)));
			out.append(p);
		});
		return out;
	}

	const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
	const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
	const send = (key, value) => vscode.postMessage({ type: "set", key, value });
	const persist = () => vscode.setState({ tab: activeTab, query });

	// ---- controls

	function colorField(value, onChange, label)
	{
		const six = (v) => (v && HEX.test(v) ? "#" + (v.length <= 5 ? v.slice(1, 4).split("").map(c => c + c).join("") : v.slice(1, 7)) : "#000000");
		const text = el("input", { type: "text", class: "hex", value: value || "", placeholder: "#RRGGBB", "aria-label": label || S.color, spellcheck: "false" });
		const pick = el("input", { type: "color", value: six(value), class: value ? "" : "empty", title: label || S.color, "aria-label": label || S.color });
		const clear = el("button", {
			class: "icon", title: S.clear, "aria-label": S.clear,
			onclick: function () { text.value = ""; pick.classList.add("empty"); text.classList.remove("bad"); onChange(""); },
		}, "×");
		pick.addEventListener("input", function ()
		{
			const alpha = HEX.test(text.value) && text.value.length == 9 ? text.value.slice(7) : "";
			text.value = pick.value + alpha;
			pick.classList.remove("empty");
			text.classList.remove("bad");
			onChange(text.value);
		});
		text.addEventListener("change", function ()
		{
			const v = text.value.trim();
			if (v === "" || HEX.test(v))
			{
				text.classList.remove("bad");
				pick.value = six(v);
				pick.classList.toggle("empty", v === "");
				onChange(v);
			}
			else
			{
				text.classList.add("bad");
			}
		});
		return el("span", { class: "colorfield" }, pick, text, clear);
	}

	function styleSelect(value, options, onChange)
	{
		return el("select", { class: "style", "aria-label": S.style, onchange: (e) => onChange(e.target.value) },
			options.map(o => el("option", { value: o, selected: o === (value || "") }, o === "" ? "-" : o)));
	}

	// a short style ("#FF8800 bold") becomes { color, fontStyle }
	function toObject(v)
	{
		if (v && typeof v == "object")
		{
			return Object.assign({}, v);
		}
		const out = {};
		const words = [];
		String(v || "").trim().split(/\s+/).forEach(function (w)
		{
			if (HEX.test(w))
			{
				out.color = w;
			}
			else if (/^(bold|italic|underline|strikethrough)$/i.test(w))
			{
				words.push(w.toLowerCase());
			}
		});
		if (words.length)
		{
			out.fontStyle = words.join(" ");
		}
		return out;
	}

	function styleRow(label, desc, value, fontStyles, onChange, extra)
	{
		const cur = toObject(value);
		const emit = function ()
		{
			const o = {};
			for (const k of ["color", "darkColor", "lightColor", "fontStyle"])
			{
				if (cur[k])
				{
					o[k] = cur[k];
				}
			}
			onChange(o);
		};
		return el("div", { class: "stylerow" },
			el("div", { class: "stylename" }, el("code", {}, label), desc ? el("span", { class: "muted" }, " " + desc) : null),
			el("div", { class: "stylecells" },
				el("label", {}, S.color, colorField(cur.color, v => { cur.color = v; emit(); }, S.color)),
				el("label", {}, S.dark, colorField(cur.darkColor, v => { cur.darkColor = v; emit(); }, S.dark)),
				el("label", {}, S.light, colorField(cur.lightColor, v => { cur.lightColor = v; emit(); }, S.light)),
				el("label", {}, S.style, styleSelect(cur.fontStyle, fontStyles, v => { cur.fontStyle = v; emit(); })),
				extra || null));
	}

	function control(item)
	{
		const v = item.value;
		switch (item.kind)
		{
			case "boolean":
				return el("input", { type: "checkbox", checked: !!v, onchange: (e) => send(item.key, e.target.checked) });
			case "enum":
				return el("select", { onchange: (e) => send(item.key, e.target.value) },
					item.options.map(o => el("option", { value: o.value, selected: o.value === v, title: o.label }, o.value + (o.label && o.label !== String(o.value) ? " - " + o.label : ""))));
			case "color":
				return colorField(v, (c) => send(item.key, c), item.title);
			case "number":
				return el("input", { type: "number", value: v, min: item.min, max: item.max, step: item.integer ? 1 : "any", onchange: (e) => send(item.key, e.target.value) });
			case "text":
				return el("input", { type: "text", class: "wide", value: v === undefined ? "" : v, spellcheck: "false", onchange: (e) => send(item.key, e.target.value) });
			case "list":
				return el("textarea", {
					rows: Math.max(2, (v || []).length + 1), class: "wide", spellcheck: "false", title: S.oneLine, placeholder: S.oneLine,
					onchange: (e) => send(item.key, e.target.value.split(/\r?\n/)),
				}, (v || []).join("\n"));
			case "map":
			{
				const cur = Object.assign({}, v || {});
				return el("div", { class: "map" }, item.fields.map(f => el("label", {}, el("code", {}, f),
					el("input", { type: "text", value: cur[f] || "", spellcheck: "false", onchange: (e) => { cur[f] = e.target.value; send(item.key, cur); } }))));
			}
			case "compilers":
			{
				const cur = (v || []).map(c => ({ language: c.language, path: c.path }));
				const holder = el("div", { class: "styles" });
				const draw = function ()
				{
					holder.replaceChildren(...cur.map((entry, i) => el("div", { class: "map" },
						el("select", { onchange: (e) => { entry.language = e.target.value; send(item.key, cur); } },
							["pluto", "lua"].map(l => el("option", { value: l, selected: l === entry.language }, l))),
						el("input", { type: "text", class: "wide", value: entry.path, placeholder: S.compilerPath, spellcheck: "false", onchange: (e) => { entry.path = e.target.value; send(item.key, cur); } }),
						el("button", { class: "icon", title: S.remove, "aria-label": S.remove, onclick: () => { cur.splice(i, 1); send(item.key, cur); draw(); } }, "×"))),
						el("button", { onclick: () => { cur.push({ language: "pluto", path: "" }); draw(); } }, "+ " + S.add));
				};
				draw();
				return holder;
			}
			case "colors":
			{
				const cur = Object.assign({}, v || {});
				return el("div", { class: "styles" }, item.categories.map(c => styleRow(c.name, "", cur[c.name], item.fontStyles, function (o)
				{
					if (Object.keys(o).length)
					{
						cur[c.name] = o;
					}
					else
					{
						delete cur[c.name];
					}
					send(item.key, cur);
				})));
			}
			case "bracketColors":
			{
				const cur = (v || []).map(toObject);
				const holder = el("div", { class: "styles" });
				const draw = function ()
				{
					holder.replaceChildren(...cur.map((entry, i) => styleRow(String(i + 1), "", entry, item.fontStyles,
						(o) => { cur[i] = o; send(item.key, cur); },
						el("button", { class: "icon", title: S.remove, "aria-label": S.remove, onclick: () => { cur.splice(i, 1); send(item.key, cur); draw(); } }, "×"))),
						el("button", { onclick: () => { cur.push({}); draw(); } }, "+ " + S.add));
				};
				draw();
				return holder;
			}
			default:
				return el("textarea", {
					rows: 4, class: "wide",
					onchange: function (e) { try { send(item.key, JSON.parse(e.target.value)); } catch (err) { e.target.classList.add("bad"); } },
				}, JSON.stringify(v, null, 2));
		}
	}

	// ---- the page

	function itemView(item)
	{
		const wide = ["colors", "bracketColors", "compilers", "list", "map", "json", "text"].includes(item.kind);
		const row = el("section", { class: "item " + (wide ? "stack" : ""), "data-key": item.key },
			el("div", { class: "head" },
				el("h3", {}, item.title),
				el("span", { class: "status", "aria-live": "polite" }),
				el("button", { class: "link", title: S.reset, onclick: () => vscode.postMessage({ type: "reset", key: item.key }) }, S.reset)),
			richText(item.description),
			el("div", { class: "control" }, control(item)));
		row.classList.toggle("modified", !same(item.value, item.default));
		return row;
	}

	function matches(item)
	{
		if (!query)
		{
			return true;
		}
		const q = query.toLowerCase();
		return item.key.toLowerCase().includes(q) || (item.description || "").toLowerCase().includes(q);
	}

	function render()
	{
		const tabs = $("#tabs");
		const body = $("#body");
		tabs.replaceChildren(...model.tabs.map(function (tab)
		{
			const n = query ? tab.items.filter(matches).length : 0;
			return el("button", {
				role: "tab", class: "tab " + (tab.id == activeTab ? "active" : ""), "aria-selected": tab.id == activeTab,
				onclick: function () { activeTab = tab.id; persist(); render(); },
			}, tab.title, query ? el("span", { class: "badge" }, n) : null);
		}));
		const tab = model.tabs.find(x => x.id == activeTab);
		const items = tab.items.filter(matches);
		body.replaceChildren(...(items.length ? items.map(itemView) : [el("p", { class: "muted" }, S.nothing)]));
	}

	$("#search").placeholder = S.search;
	$("#search").addEventListener("input", function (e)
	{
		query = e.target.value.trim();
		if (query)
		{
			const here = model.tabs.find(t => t.id == activeTab);
			const first = model.tabs.find(t => t.items.some(matches));
			if (first && !here.items.some(matches))
			{
				activeTab = first.id;
			}
		}
		persist();
		render();
	});
	$("#search").value = query;
	$("#openJson").textContent = S.openJson;
	$("#openJson").addEventListener("click", () => vscode.postMessage({ type: "openJson" }));
	document.title = S.title;
	$("#title").textContent = S.title;

	window.addEventListener("message", function (event)
	{
		const m = event.data;
		if (m.type == "saved")
		{
			const item = itemByKey.get(m.key);
			if (item && m.ok)
			{
				item.value = m.value;
			}
			const row = $("[data-key=\"" + m.key + "\"]");
			if (!row)
			{
				return;
			}
			if (m.ok)
			{
				row.classList.toggle("modified", !same(item.value, item.default));
				const st = $(".status", row);
				st.textContent = S.saved;
				st.className = "status ok";
				setTimeout(() => { st.textContent = ""; }, 1500);
			}
			else
			{
				// The control shows the value that is in force, with the reason.
				if (item)
				{
					item.value = m.value;
				}
				row.replaceWith(itemView(item));
				const again = $("[data-key=\"" + m.key + "\"] .status");
				if (again)
				{
					again.textContent = S.invalid + ": " + m.error;
					again.className = "status err";
				}
			}
		}
		else if (m.type == "values")
		{
			for (const [key, value] of Object.entries(m.values))
			{
				const item = itemByKey.get(key);
				if (!item || same(item.value, value))
				{
					continue;
				}
				item.value = value;
				const row = $("[data-key=\"" + key + "\"]");
				if (row && !row.contains(document.activeElement))
				{
					row.replaceWith(itemView(item));
				}
			}
		}
	});

	render();
})();
