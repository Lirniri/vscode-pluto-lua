<p align="center"><img src="readme-logo.png" alt="Pluto → Lua" width="400"></p>

# Pluto & Lua Mini-IDE

For information regarding the installation, features, & usage of this editor integration, [have a look at our documentation](https://plutolang.github.io/docs/Editor%20Integration).

Русская версия этого файла: [README.ru.md](README.ru.md).

## Features in Visual Studio Code

Besides syntax highlighting and snippets, the VS Code extension provides language features for `.pluto` files:

- **Completion** for Pluto keywords, the standard library (`string.split`, `table.contains`, `io.listdir`, `json.encode`, ...), built-in modules (`require "pluto:json"`), and everything declared in your workspace: classes, methods, fields, functions with their parameters and type hints, enums, and module ids from `info.json` manifests.
- **Hover** with the signature, the comment written above the declaration, the file it comes from and, for functions and methods, their source code in a compact form (comments removed, indentation normalized, logical blocks separated by blank lines; see `pluto.hover.showFunctionBody` and `pluto.hover.maxBodyLines`). Hovering a return type (`void` in `function f(): void`) also shows what the developer wrote in an `@return` comment, above the function or inside of its body, e.g. `-- @return bool Whether it worked`; the same lines are part of the function's hover and signature help.
- **Signature help** when typing `(`, highlighting the current argument.
- **Go to Definition** (`F12` / `Ctrl+Click`) for classes, methods, functions, variables, and the file behind `require("...")`.
- **Outline & breadcrumbs**, **Go to Symbol in Workspace** (`Ctrl+T`), and **folding** of blocks, comments and `--#region` markers.
- **Type hints**: typing `:` in `function f(a: `, `function f(): ` or `local x: ` opens the list of types (built-in types and your classes, each also as nullable `int?`); nullable types are highlighted and explained on hover (`(nullable type) int? — Can be int or nil`), also in signature help. Both spellings, `int?` and `?int`, are understood.
- **Peek Code**: a **Peek Code** link at the bottom of a hover (`Показать код` in Russian) opens the declaration in a wide peek window with the code on the left and the list of locations on the right, even when there is only one declaration.
- **Union types** (`int|string`, `?int|string?`): hover the `|` to see what the whole union can hold, with `nil` made explicit.
- **Custom highlight colors**: colors and font styles of functions, parameters, types, return types, keywords, operators, table braces by nesting depth and more, each with its own color for dark and light themes and a color picker in `settings.json`; wrong values are reported and never applied. See [Highlight colors](#highlight-colors).
- **Lua syntax check**: with `pluto.lua.enable` on, `.lua` files are checked for syntax errors by a Lua interpreter (`luac`, `lua` or `luajit`) found in `bin/lua`, `tools/lua` and similar folders of the workspace, or on the `PATH`. The code is only compiled, never run.
- **Paths of files in JSON files**: a path such as `"entry": "src/main.pluto"` that points to a missing file gets a warning, with a quick fix when the file was only moved. See [JSON path checks](#json-path-checks).
- **Smart multi-line lists**: for a function whose `(` ... `)` or a table whose `{` ... `}` stands on lines of its own, the first element typed right after the opening bracket moves to its own indented line, and Enter at the end of an element adds the missing comma. See [Multi-line parameters and tables](#multi-line-parameters-and-tables).
- **Default values of parameters**: the type of a parameter that has no default value (`test: bool`) gets a yellow wavy line while the cursor is on it, with a tooltip, and the values that fit the type (`= false`, `= true`) are suggested, by themselves when the cursor rests. See [Default values of parameters](#default-values-of-parameters).
- **Typing helpers**: a new line after the comma of a multi-line list (after a pause, so you can go on typing), grey suggestions that `Tab` takes (`()` after `function`, ` = ` after `["key"]`, ` then` / ` do` after a block header), a warning for a parameter or table key written twice, and a quick fix (or an automatic fix after a pause) for a closing bracket that does not fit the last opened one (`{ ]`). See [Typing helpers](#typing-helpers).
- **Settings panel**: the command **Pluto: Settings** opens a window with a tab for each group of settings, switches, choices and real color pickers. See [Settings panel](#settings-panel).
- **Types and `switch` hints**: a grey `:` after a parameter name that has no type or after the `)` of a function (`Tab` opens the list of types), the values that fit a `return`, a grey `break` / `case` / `default:` and a `:` after a `case`, yellow lines for what is missing, and warnings for a function that does not return what it says. See [Typing helpers](#typing-helpers).
- **Automatic `end`** when pressing Enter after `function`, `if ... then`, `for ... do`, `while ... do`, `class`, `switch ... do`, etc.
- **Live diagnostics** (squiggles and the Problems panel):
  - errors and warnings of the Pluto compiler, which checks the code without running it (`plutoc -p -`; with only the `pluto` interpreter, the code is compiled with `load` and never called);
  - built-in checks that need no compiler: `require("...")` of a module that doesn't exist in the workspace, calls with fewer arguments than the function has required parameters (parameters with `?` or `= default` are optional), and in `info.json`: a missing `id`, an `entry` file that doesn't exist, and `dependencies` with unknown ids.

  The compiler is taken from `pluto.diagnostics.compilerPath`; when that is empty, from the workspace (`pluto/*/plutoc.exe`, `bin/pluto/*/plutoc.exe`, `tools/pluto/...`; the newest version wins, `plutoc` before `pluto`), then from `PATH`. If none is found, only the built-in checks run. The compiler in use is logged in the **Pluto** output channel. In untrusted workspaces no compiler is run.

The language features also work in `.lua` files (switch them off with `pluto.lua.enable`, e.g. when `sumneko.lua` is installed; the compiler check only runs on `.pluto` files). All `.pluto` and `.lua` files of the workspace are indexed in the background and kept up to date as you edit. Files matched by `.gitignore`, `.plutoignore` or the exclude settings below are left out: they don't show up in completion, hover or Go to Definition of other files, and the index follows along when an ignore file changes. An excluded file that you open still gets all features for its own code. This is a lightweight index, not a full language server: types are only inferred from type hints, `new Class(...)` and `require`.

### Snippets

| Prefix | Result |
| --- | --- |
| `class`, `cls` | Class with constructor |
| `cls_ext` | Class extending another class |
| `fn`, `lfn`, `fnt`, `lambda` | Function, local function, typed function, lambda |
| `switch` | Switch block |
| `try` | `pcall` / `xpcall` (the try/catch statement was removed from Pluto) |
| `fori`, `forp`, `forip`, `fora` | Numeric, `pairs`, `ipairs`, and for-as loops |
| `enum`, `req`, `pluto_use` | Enumeration, `require "pluto:..."`, `pluto_use "version"` |

### Languages (English and Russian)

The messages of the extension (labels in hovers and completion, built-in diagnostics, status and output texts) come in English and Russian. `pluto.language` is `auto` by default: Russian when the display language of the editor is Russian (`ru`, `ru-RU`), English otherwise. Set it to `en` or `ru` to pin the language; it changes on the fly, no reload needed. The names and descriptions of settings and commands are localized by VS Code itself through `package.nls.json` / `package.nls.ru.json` and follow its display language (*Configure Display Language*). Texts of the Pluto compiler and the built-in library documentation stay in English.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pluto.language` | `auto` | Language of the extension's messages: `auto` (follow the editor), `en` or `ru`. |
| `pluto.index.enabled` | `true` | Index the whole workspace; otherwise only open files are analyzed. |
| `pluto.lua.enable` | `true` | Language features (completion, hover, go to definition, signature help, outline, folding, diagnostics) for `.lua` files. Turn off if e.g. `sumneko.lua` already provides them; takes effect immediately. |
| `pluto.lua.indexFiles` | `true` | Read `.lua` files into the index so Pluto code gets completion and navigation into the Lua modules it requires. Independent of `pluto.lua.enable`. |
| `pluto.index.includeLua` | `true` | Deprecated, use `pluto.lua.indexFiles`. Still honored: when `false`, `.lua` files are not indexed. |
| `pluto.workspace.useGitignore` | `true` | Leave files matched by `.gitignore` out of the index. |
| `pluto.workspace.ignoreFiles` | `[".gitignore", ".plutoignore", ".luaignore"]` | Ignore files (`.gitignore` syntax) in the workspace root to read exclusions from. |
| `pluto.workspace.exclude` | `[]` | Glob patterns to leave out of the index, e.g. `**/vendor/**`. |
| `pluto.workspace.useSearchExclude` | `true` | Also apply `search.exclude`. `files.exclude` always applies. |
| `pluto.index.maxFiles` | `5000` | Maximum number of files to index. |
| `pluto.completion.keywords` | `true` | Suggest keywords. |
| `pluto.completion.documentWords` | `true` | Suggest other words of the current document. |
| `pluto.completion.autoTriggerTypes` | `true` | Open the list of types by itself after `:` in type hints (`a: `, `): `, `local x: `), in Pluto files only. |
| `pluto.completion.defaultValues` | `true` | Suggest the values a parameter can get as its default (`= false`, `= 0`, `= nil`, ...) after its type. |
| `pluto.completion.defaultValuesDelayMs` | `800` | How long the cursor has to rest after the type before that list opens by itself. `0` = only on `Ctrl+Space`. |
| `pluto.highlight.paramNoDefault` | `true` | Yellow wavy line under the type of the parameter the cursor is on when it has no default value. |
| `pluto.highlight.paramNoDefaultColor` | `#E5C07B` | Color of that line in dark and high contrast themes. |
| `pluto.highlight.paramNoDefaultLightColor` | `#BF8803` | Its color in light themes. |
| `pluto.highlight.nullableTypes` | `true` | Highlight nullable types (`int?`, `?string`, `Vehicle?`). |
| `pluto.highlight.nullableTypeColor` | `#FFFFFF` | Their color in dark and high contrast themes. |
| `pluto.highlight.nullableTypeLightColor` | `#000000` | Their color in light themes. |
| `pluto.highlight.applyColors` | `false` | Apply the colors below to Pluto files (off = the colors of your theme). |
| `pluto.highlight.colors` | `{}` | Color and style per kind of token, see [Highlight colors](#highlight-colors). |
| `pluto.highlight.tableBracketColors` | `[]` | Colors of the braces `{ }` of tables by nesting depth. |
| `pluto.lua.checkSyntax` | `true` | Check `.lua` files for syntax errors with a Lua interpreter (needs `pluto.lua.enable`). |
| `pluto.lua.compilerPath` | `""` | Path to `luac` / `lua` / `luajit`. Empty = search `bin/lua`, `tools/lua`... of the workspace, then the `PATH`. |
| `pluto.json.enable` | `true` | Check the paths of files in JSON files. |
| `pluto.json.files` | `["**/info.json"]` | Glob patterns of the JSON files to check. |
| `pluto.json.extensions` | `[".pluto", ".lua"]` | Extensions of the files whose paths are checked. |
| `pluto.json.checkAllPaths` | `false` | Also check paths of files with any extension found in the project folder. |
| `pluto.json.severity` | `warning` | `warning`, `error` or `information`. |
| `pluto.json.notifyNoFolder` | `true` | Tell once per window that without an open folder paths are checked only next to the JSON file. |
| `pluto.format.multilineParams` | `true` | Smart formatting of multi-line parameter lists of functions. |
| `pluto.format.multilineTables` | `true` | Smart formatting of multi-line tables. |
| `pluto.format.newLineAfterComma` | `true` | Start a new line after a comma typed at the end of an element of a multi-line list, unless you go on typing. |
| `pluto.format.newLineAfterCommaDelayMs` | `700` | Pause before that line starts; typing or moving the cursor cancels it. `0` = at once. |
| `pluto.format.suggestParens` | `true` | Grey `()` after `function`; `Tab` takes it and puts the cursor between the brackets. |
| `pluto.format.suggestTableKeyAssign` | `true` | Grey ` = ` after the key `["name"]` of a table field. |
| `pluto.format.suggestBlockWords` | `true` | Grey ` then` after `if` / `elseif` and ` do` after `while` / `for` headers. |
| `pluto.format.fixMismatchedBrackets` | `suggest` | A closer that does not fit (`{ ]`): `off`, `suggest` (underline and quick fix) or `auto` (also replaced by itself after a pause). |
| `pluto.format.fixMismatchedBracketsDelayMs` | `1200` | The pause before `auto` replaces the closer. `0` = at once. |
| `pluto.diagnostics.duplicateParams` | `warning` | A name written twice in parameters (`function f(a, a)`) or a key twice in a table: `warning`, `error` or `off`. |
| `pluto.format.ifBlockWord` | `auto` | Which word is suggested after `if` / `elseif`: `then`, `do` (both are valid in Pluto), `off`, or `auto` (what your file and workspace use). |
| `pluto.format.suggestFor` | `true` | Suggestions while the header of a `for` is written. |
| `pluto.format.nameStyle` | `short` | Variable names in those suggestions: `short` (`i`, `k`, `v`, `t`) or `full` (`index`, `key`, `value`, `table_name`). |
| `pluto.format.names` | `{}` | Your own words for `index`, `key`, `value` and `table` in those suggestions. |
| `pluto.hover.forPreview` | `true` | Hovering a numeric `for` shows the values the variable goes through. |
| `pluto.format.suggestParamType` | `true` | A grey `:` after the name of a parameter that has no type; `Tab` inserts `: ` and opens the list of types. |
| `pluto.format.suggestParamTypeDelayMs` | `600` | The pause before such a grey colon (also after the `)` of a function and after a `case`) is shown. `0` = at once. |
| `pluto.format.suggestReturnType` | `true` | A grey `: ` after the `)` of a function that has no return type. |
| `pluto.format.suggestReturnValue` | `true` | The values that fit the return type after `return `. |
| `pluto.format.suggestCaseColon` | `true` | A grey `:` after the values of a `case`. |
| `pluto.format.suggestCaseBreak` | `true` | A grey `break` in the body of a `case` that nothing ends. |
| `pluto.format.suggestCaseWords` | `true` | A grey `case ` / `default:` at the level of the cases of a `switch`. |
| `pluto.highlight.paramNoType` | `true` | A yellow line under the name of a parameter that has no type, while the cursor is on it. |
| `pluto.highlight.caseNoColon` | `true` | A yellow line under a `case` that has no `:`, while the cursor is on its line. |
| `pluto.diagnostics.returnTypes` | `warning` | A function that says it returns a type but never uses `return`, and a `void` function that returns a value: `warning`, `error` or `off`. |
| `pluto.diagnostics.caseFallthrough` | `off` | `hint` marks a `case` that nothing ends and that runs into the next one. |
| `pluto.autoCloseBlocks` | `true` | Insert `end` / `until` on Enter. |
| `pluto.hover.sourcePath` | `short` | How links to declarations in other files look: `short`, `relative` or `none`. |
| `pluto.hover.showFunctionBody` | `true` | Show the source of a function below its signature in hovers. |
| `pluto.hover.maxDeclarations` | `8` | How many declarations a hover lists when several share a name; a link opens all of them in the references peek. |
| `pluto.hover.maxBodyLines` | `25` | Longest function source shown in hovers; longer ones are cut with `-- ... (+N lines)` (`(+N строк)` in Russian). `0` = no limit. |
| `pluto.outline.showFunctionBody` | `true` | Show the contents of functions in the Outline (locals, nested functions, callbacks, calls). |
| `pluto.outline.maxFileLines` | `1000` | In larger files, show only classes, methods and function signatures. `0` = no limit. |
| `pluto.outline.calls` | `none` | List calls inside functions: `none`, `statements` (call statements and `return`), or `all` (also calls inside expressions, once per callee). |
| `pluto.outline.localVariables` | `true` | Show variables declared inside functions in the Outline. |
| `pluto.outline.loopVariables` | `false` | Show `for` loop variables in the Outline. |
| `pluto.outline.parameters` | `false` | Show function parameters in the Outline. |
| `pluto.outline.anonymousFunctions` | `true` | Show callbacks such as `scheduler:add() callback` in the Outline. |
| `pluto.outline.fields` | `true` | Show `self.x = ...` fields as class members in the Outline. |
| `pluto.outline.showValues` | `true` | Show initial values next to variables and fields, e.g. `count = 0`. |
| `pluto.diagnostics.enable` | `true` | Show compiler errors and built-in checks in the editor and the Problems panel. |
| `pluto.diagnostics.compilerPath` | `""` | Path to `plutoc`/`pluto`, e.g. `${workspaceFolder}/bin/pluto/0.13.2/plutoc.exe`. Empty = search the workspace, then `PATH`. |
| `pluto.diagnostics.debounceMs` | `400` | Delay after the last edit before a file is checked again. |

### Highlight colors

The extension does not change how your theme looks until you turn this on. Set `pluto.highlight.applyColors` to `true` and describe only the kinds of tokens you want to recolor:

```jsonc
"pluto.highlight.applyColors": true,
"pluto.highlight.colors": {
    "functionName": { "color": "#FF8800", "fontStyle": "bold" },
    "parameter":    { "color": "#9CDCFE", "fontStyle": "italic" },
    "returnType":   { "color": "#4EC9B0" },
    "keyword":      "#C586C0"                   // short form: a color, optionally followed by bold / italic / underline / strikethrough
},
"pluto.highlight.tableBracketColors": ["#E6B450", "#59C2FF", "#AAD94C"]
```

Each entry is either an object with `color` and `fontStyle`, or a short string such as `"#FF8800 bold"`. In `settings.json` the `color` of the object form gets a color picker (click the swatch next to the value). `fontStyle` is one of `normal`, `bold`, `italic`, `bold italic`, `underline`, `bold underline`, `italic underline`. A color can carry transparency (`#FF880080`).

**Dark and light themes.** The object form can give each kind of theme its own color:

```jsonc
"returnType": { "color": "#4EC9B0", "lightColor": "#007A62" }
"functionName": { "darkColor": "#FFD866", "lightColor": "#8A6500" }
```

`color` is used in every theme, `darkColor` overrides it in dark and high contrast themes, `lightColor` in light and high contrast light themes. A color that is not set falls back to `color`; if there is none for the current kind of theme, the color of the theme stays. All three get a color picker, and the colors are switched by themselves when you change the theme. The same object form works in `pluto.highlight.tableBracketColors`. The short string form (`"#FF8800 bold"`) has one color for every theme.

A wrong value is never applied: the color of your theme stays, and the extension shows a warning that names the setting and the value, with a button that opens `settings.json`. This covers a value that is not a color or style (`"blue"`, a typo in `fontStyle`), a fully transparent color (`#0000`, `#00000000`), which would make the text invisible, and an unknown key (`"functonName"`). An empty string `""` simply means "not set".

| Key | What it colors |
| --- | --- |
| `functionName` | Names of declared functions and methods, also with long paths (`function api.handlers.add`). |
| `functionKeyword` | The `function` keyword and the `->` of lambdas. |
| `parameter` | Parameters of functions and lambdas (`\|x: int\| -> int { ... }`). |
| `type` | Types in type hints: `int`, `string`, `Vehicle`, `int?`, `int|string`, in parameters and variables. |
| `returnType` | Only the type a function or a lambda returns: `void` in `function f(): void`, `int` in `\|x: int\| -> int { ... }`. Types in the parameters keep the color of `type`. |
| `typeColon` | The `:` before a type in a type hint. |
| `keyword` | `if`, `then`, `end`, `return`, `for`, ... |
| `operator` | `=`, `+`, `and`, `?`, `??`, ... |
| `constant` | `true`, `false`, `nil`. |
| `modifier` | `local`, `public`, `private`, `static`, ... |
| `accessor` | The `.` between names, as in `a.b.c`. |

`pluto.highlight.tableBracketColors` colors the braces `{ }` of nested tables by depth: the first entry is for the outermost table, the next one for the table inside it, and so on. A list shorter than the depth repeats, and up to 8 levels are told apart. Entries are written like above, e.g. `[{ "color": "#E6B450", "fontStyle": "bold" }, "#59C2FF"]`.

The extension keeps these colors as rules named `Pluto: ...` in `editor.tokenColorCustomizations` of your user settings. Your own rules there are left alone, and turning `pluto.highlight.applyColors` off removes ours. The rules only match Pluto scopes (`....pluto`), so other languages are not affected.

[demo-highlight.pluto](demo-highlight.pluto) in this repository contains every kind of token to look at while tuning the colors. Nullable types (`int?`) have their own settings, `pluto.highlight.nullableTypeColor` and `pluto.highlight.nullableTypeLightColor`, because they are colored on top of the theme.

### JSON path checks

Strings in a JSON file that look like the path of a file are checked. By default this is done for module manifests (`info.json`) and only for `.pluto` and `.lua` files, so nothing unexpected appears in other JSON files. A string is taken for a path when it ends with one of the extensions, is not a URL or a pattern (`*`, `{}`), and is not a sentence.

```jsonc
{
    "id": "garage",
    "entry": "main.pluto",
    "helper": "old/util.lua"          // warning: File 'old/util.lua' not found. Did you mean '../lib/util.lua'?
}
```

- **Where it looks:** a path is valid when the file exists next to the JSON file or relative to a workspace folder (or when it is absolute). Files excluded by `.gitignore`, `.plutoignore`, `.luaignore` or `files.exclude` still count as existing when they are on the disk.
- **Moved files:** when the file is missing but a file with that name exists elsewhere in the project, the warning names it, and a quick fix (`Ctrl+.`) replaces the path with the one relative to the JSON file. The nearest file, and the one whose path ends like the written one, comes first.
- **Which JSON files:** `pluto.json.files` is a list of glob patterns relative to the workspace folder, e.g. `["**/info.json", "config/*.json"]`, or `["**/*.json"]` for all of them. The `id`, `entry`/`main` and `dependencies` of a module manifest (`info.json`) are always checked.
- **Other files:** `pluto.json.extensions` lists the extensions that are checked. With `pluto.json.checkAllPaths` every extension found among the files of the project folder (`.png`, `.txt`, ...) is checked too; for this the names of all files are read once, without the ignored ones.
- **No folder open:** without a project folder (a single JSON file) only the neighbourhood of the file on the disk is searched, and there are no "did you mean" hints. The extension tells it once per window with a notification (turn it off with `pluto.json.notifyNoFolder`).

### Ignore files

The files that match `.gitignore`, `.plutoignore` or `.luaignore` (all in the workspace root, `.gitignore` syntax; the list is `pluto.workspace.ignoreFiles`) are not indexed, so they get no completion or navigation. `pluto.workspace.exclude` adds glob patterns, and `files.exclude` and `search.exclude` apply as well.

### Lua interpreter

While `pluto.lua.enable` is on, `.lua` files are checked for syntax errors by a Lua interpreter, in the same way `plutoc` checks `.pluto` files. The interpreter is `pluto.lua.compilerPath`, else `luac`, `lua` or `luajit` in `bin/lua`, `tools/lua`, `lua5.4` and similar folders of the workspace (`luac`, which only parses, is preferred; the newest version wins), else the `PATH`. With `lua` or `luajit` the code is compiled with `load` and never run. A workspace has to be trusted for a program from it to be started. Turn this off with `pluto.lua.checkSyntax`.

### Multi-line parameters and tables

For `.pluto` and `.lua` files (the Lua files while `pluto.lua.enable` is on). It only works on a list that is already written on several lines, i.e. whose closing `)` or `}` is on a line of its own below the opening one, and does nothing for one-line lists.

**The first element moves to its own line.** If you start typing the first parameter or field right after the opening bracket, it moves to the next line, one level deeper than the line with the bracket:

```pluto
function name(test: bool = false      -- typed on the line of `(`, `)` is on a line below
)

-- becomes
function name(
    test: bool = false
)

local cfg = { enabled = true          -- the same for tables
}

-- becomes
local cfg = {
    enabled = true
}
```

**Enter adds the comma.** Press Enter at the end of a parameter or field inside such a list and the missing comma is put at the end of it (before a `-- comment`, if there is one), and the cursor goes to a new line with the same indentation. A comma (or a `;` in a table) that is already there is not doubled, and Enter on an empty line is just a line break:

```pluto
function name(
    test: bool = false|          -- Enter
)

-- becomes
function name(
    test: bool = false,
    |
)
```

It is careful not to break your code: strings and comments are skipped; nested tables and lists work on their own level; a line that ends with an opening bracket or an unfinished expression (`a = 1 +`) gets no comma; `...` stays the last parameter without a comma; statements inside a function in a table, the body of a lambda (`-> int { ... }`) and the arguments of a call are left alone; and the automatic `end` keeps working. Both can be turned off, `pluto.format.multilineParams` for parameter lists and `pluto.format.multilineTables` for tables.

### Default values of parameters

While you write the parameters of a function declaration in a Pluto file, a parameter that has a type but no default value is marked, and the values that fit its type are offered.

```pluto
function name(test: bool|)          -- the cursor is right after the type
```

- **Yellow line.** The type (`bool`) gets a yellow wavy line while the cursor is on the parameter; hover it for a tooltip such as ``` `test` has no default value. You can give it `= false`, `= true`. ``` The line goes away when the cursor leaves the parameter or a comma is typed, and it is not shown for a parameter that already has `= value`, for a parameter without a type, or for a type that is still being typed (`bo`). It is a hint of the editor, not a message in the Problems panel. Switch it off with `pluto.highlight.paramNoDefault`; its colors are `pluto.highlight.paramNoDefaultColor` and `pluto.highlight.paramNoDefaultLightColor`.
- **Values by type.** With the cursor right after the type (or after a space behind it) the list of suggestions starts with the values that fit, inserted as ` = value`:

  | Type | Suggested |
  | --- | --- |
  | `bool` | `= false`, `= true` |
  | `int` | `= 0`, `= 1`, `= -1` |
  | `float` | `= 0.0`, `= 1.0`, `= -1.0` |
  | `number` | `= 0`, `= 1`, `= -1` |
  | `string` | `= ""` |
  | `table`, `{ x: int }` | `= {}` |
  | `function` | `= function() end` |
  | `any` | `= nil`, `= false`, `= 0`, `= ""`, `= {}` |
  | a class (`Vehicle`) | `= new Vehicle()` |
  | `int?`, `?string`, ... | the values of the type, then `= nil` |
  | `int\|string` | the values of each member |

  The types stay in the list behind them (`bool` can still become `boolean`). Press `Ctrl+Space` to open the list yourself.
- **By itself.** If the cursor rests right after the type for `pluto.completion.defaultValuesDelayMs` (800 ms), the list opens without a key. Moving the cursor or typing starts the wait again, and the list is not opened twice for the same place. Set the delay to `0` to switch this off, or `pluto.completion.defaultValues` to `false` to switch off the values altogether.

### Typing helpers

Small helps while you type, for `.pluto` files and, where it makes sense, `.lua` files (while `pluto.lua.enable` is on). Each one has its own setting.

**A new line after the comma.** In a multi-line parameter list or table (the closing `)` or `}` is on a line of its own below), a comma typed at the end of an element starts a new line with the indentation of the elements, as `end` appears after Enter. The new line comes after a short pause (`pluto.format.newLineAfterCommaDelayMs`, 700 ms): if you go on typing or move the cursor, it does not come, so `test: bool = false, test1` can stay on one line. One-line lists, calls and a line that already has an empty line below it are left alone.

```pluto
function name(
    test: bool = false,|          -- stop for a moment after the comma
)

-- becomes
function name(
    test: bool = false,
    |
)
```

**Suggestions in grey.** The text that would follow is shown in grey after the cursor, and `Tab` takes it (these are the inline suggestions of VS Code, `editor.inlineSuggest.enabled`):

| You typed (`▮` is the cursor) | Grey suggestion | After `Tab` | Setting |
| --- | --- | --- | --- |
| `function▮`, `function name▮`, `local f = function▮` | `()` | `function(▮)`, the cursor is between the brackets | `pluto.format.suggestParens` |
| `["key"]▮` at the start of a table field | ` = ` | `["key"] = ▮` | `pluto.format.suggestTableKeyAssign` |
| `if x▮`, `elseif a and b▮` | ` then` | `if x then▮` (Enter then adds the `end`) | `pluto.format.suggestBlockWords` |
| `while x▮`, `for i = 1, 3▮`, `for k, v in pairs(t)▮` | ` do` | `... do▮` | `pluto.format.suggestBlockWords` |

Nothing is suggested when the text is already there (`function name(`), when the header is not finished (`if a and`), in strings and comments, for a type (`x: function`), or for `local function` / `public function` without a name yet. With inline suggestions switched off, the `()` is an item of the completion list instead.

**then or do after `if`.** Pluto accepts `if x then` and `if x do` (`while` and `for` only take `do`). `pluto.format.ifBlockWord` chooses what is suggested: `then`, `do`, `off`, or `auto` (the default), which counts the `if` / `elseif` headers of the current file and follows the one used more; if the file uses both equally, the rest of the workspace decides (files that are not ignored, read once and kept for a few seconds), and `then` is taken when there is nothing to go by.

**Loops.** While the header of a `for` is written, the suggestions go with it (`Tab` takes the first, `Alt+]` shows the next one):

| You typed (`▮` is the cursor) | Suggested |
| --- | --- |
| `for▮` | `i = 1, 10`, `i, v in ipairs(t)`, `k, v in pairs(t)`, `t as v`, with places to fill in |
| `for k, v in▮` | `ipairs(t)`, `pairs(t)`, `next, t` |
| `for i = 1,▮` | `#items`, the length of the nearest table above |
| `for i = 1, 10,▮` | the step: `1`, `2`, or `-1`, `-2` when the start is larger than the end |

The nearest table of the file (`local items = { ... }`) gives the name, and its kind puts `ipairs` first for an array and `pairs` first for fields. `pluto.format.nameStyle` chooses `short` words (`i`, `k`, `v`, `t`) or `full` ones (`index`, `key`, `value`, `table_name`), and `pluto.format.names` sets your own words for any of them, e.g. `{ "value": "item" }`. All of it is `pluto.format.suggestFor`; the ready-made snippets are not affected.

**What a numeric loop goes through.** Hover the `for` of a loop with numbers to see the values: `for i = 1, 10, 2` shows `i` takes the values 1, 3, 5, 7, 9 (5 times, step 2). It says when the loop does not run (`for i = 5, 1`), when the step is 0, and for `for i = 1, 3, 5` that the step is larger than the distance, so the loop runs once. `pluto.hover.forPreview` switches it off.

**Types of parameters and of return values.** A parameter written without a type (`value2`) gets a yellow line under its name while the cursor is on it, and after a pause (`pluto.format.suggestParamTypeDelayMs`, 600 ms) a grey `:` next to it. `Tab` inserts `: ` and opens the list of types; then, once the type is complete, the suggestions of the default value take over (`= false`). The grey colon is not shown while the list of completions is open: it comes when you have closed that list (`Esc`, or a choice), however long that takes. `Esc` on the grey text hides it until you type or move the cursor. The same grey `: ` appears after the `)` of a function that has no return type. After `return ` in a function with a return type (`function f(): bool`), the values that fit it are suggested (`true`, `false`; `0`, `1`, `nil`, ... by the type). Class fields are not asked for a type: `public name` is fine in Pluto. `void`, `any` and nullable return types are not asked for a `return`.

**switch and case.** Inside of a `switch`:

| Where | Suggested | Setting |
| --- | --- | --- |
| after the values of a `case`: `case 1▮`, `case 2, 3▮` (after the pause) | `:` | `pluto.format.suggestCaseColon` |
| an empty line in the body of a `case` that nothing ends (not `default`), before the next `case`, `default` or `end` | `break` | `pluto.format.suggestCaseBreak` |
| an empty line at the level of the cases | `case ` and `default:` (`default` only once) | `pluto.format.suggestCaseWords` |

A `case` without a `:` gets a yellow line under the word `case` while the cursor is on its line (`pluto.highlight.caseNoColon`). `pluto.diagnostics.caseFallthrough` can mark, as a hint, a `case` that nothing ends (`break`, `return`, `goto`, `continue`, `error(...)`) and that runs into the next one; a case with an empty body, which gives two cases one body, is left alone. The Pluto compiler warns about the same thing.

**A function that does not return what it says.** A function with a return type (`function f(): int`) that never uses `return` gets a warning on the type, and a function that says `void` and returns a value gets one on the `return` (`pluto.diagnostics.returnTypes`: `warning`, `error` or `off`). A function that raises an error, a nullable type, `any` and a function without a body are left alone.

**Names written twice.** A parameter that has the same name as an earlier parameter of the function or lambda (`function f(a, a)`, `|x, x| -> x`) and a key that is set twice in one table (`{ a = 1, a = 2 }`, also `a` and `["a"]`) get a warning on the second one. Set `pluto.diagnostics.duplicateParams` to `error` or `off` to change that.

**A closer that does not fit.** If you type `]` where the last opened bracket is `{` and no other open bracket takes a `]`, it is underlined with `Expected '}' to close the bracket opened on line N`, and the quick fix (`Ctrl+.`) replaces it. `pluto.format.fixMismatchedBrackets` chooses what happens: `off` ignores it, `suggest` (default) underlines it and offers the fix, `auto` also replaces it by itself when you stop typing for `pluto.format.fixMismatchedBracketsDelayMs` (1200 ms). Typing or moving the cursor within that time cancels the replacement, and it is one step in the undo history. A forgotten closer (`{ a[1 }`), a stray one, and brackets in strings and comments are not touched.

### Settings panel

Run **Pluto: Settings** from the Command Palette (`Ctrl+Shift+P`) to open a window made for this extension. It has a **tab for each group**: General, Index and ignore, Lua, Completion, Hover, Outline, Diagnostics, Highlighting, Typing helpers and JSON paths. Every setting has its text, a control that fits it (a switch, a choice, a number, a text, a list with a line for each entry), a **Reset** link, and a mark at the left when it differs from the default. The colors have real **color pickers**: the colors of the highlighting are a table with a row for each kind of token (color, dark theme, light theme, style), and the colors of table braces are a list you can add to and remove from. There is a search that looks in all the tabs.

It reads and writes the same settings as the standard settings editor and `settings.json`: a change is saved at once in your user settings, a value that is the default is taken out of `settings.json` instead of being written there, and what you change in `settings.json` shows up in the panel. A value that is not allowed (a color that is not a color, a number out of range) is refused with the reason, and the control shows the value that is in force. Only the settings of this extension can be changed with it.

### Commands

- **Pluto: Run Script** — runs the current file with `pluto`.
- **Pluto: Lint Script** — checks the current file with `plutoc -p`.
- **Pluto: Rebuild Workspace Index**
- **Pluto: Settings** — opens the [settings panel](#settings-panel).

## Development

If you don't have Git installed, [do so first](https://github.com/git-guides/install-git).

### Sublime Text

In Sublime Text, select **Preferences > Browse Packages...** to open the "Packages" folder of your ST installation.

Open a console in this folder to run the following command:
```
git clone https://github.com/PlutoLang/Syntax-Highlighting "Pluto Syntax Highlighting"
```

You should now see "Pluto" as a syntax highlighting option in Sublime Text.

### Visual Studio Code

The extension is plain JavaScript and needs no build step.

| Path | Purpose |
| --- | --- |
| `Pluto.tmbundle/` | TextMate grammar, preferences and snippets (shared with Sublime Text) |
| `language-config.json` | Brackets, comments, indentation rules |
| `snippets/` | Additional VS Code snippets |
| `src/extension.js` | Entry point: registers providers, keeps the index up to date, inserts `end` |
| `src/parser.js` | Tolerant scanner extracting declarations and block structure |
| `src/workspaceIndex.js`, `src/analysis.js` | Index of all files, name & type resolution |
| `src/ignore.js`, `src/workspaceFilter.js` | `.gitignore`-style ignore files and exclude globs |
| `src/providers.js` | Completion, hover, signature help, definition, outline, folding |
| `src/builtins.js`, `src/builtins.generated.json` | Keywords and standard library |
| `src/highlightColors.js` | Highlight colors from the settings, rules for `editor.tokenColorCustomizations` |
| `src/jsonPaths.js` | Checks of the paths of files in JSON files |
| `src/multilineFormat.js`, `src/multilineEditor.js` | Smart formatting of multi-line lists and tables |
| `src/defaultValues.js`, `src/defaultValuesEditor.js` | Default values of parameters: the line, the list, the timer |
| `src/hints.js` | More typing hints: colons, return values, `switch` and `case`, return diagnostics |
| `src/settingsModel.js`, `src/settingsPanel.js`, `src/settingsClient.js` | The settings panel: tabs and what may be saved, the window, the script of the page |
| `src/autoFormat.js`, `src/autoFormatEditor.js` | Typing helpers: new line after a comma, grey suggestions, duplicate names, closers that do not fit |

- Open this folder in VS Code and press `F5` to try the extension in a new window.
- `npm test` runs the grammar tests and the language feature tests.
- `npm run package` builds a `.vsix`, which can be installed with `code --install-extension <file>.vsix`.
- `src/builtins.generated.json` is generated from [the Pluto documentation](https://github.com/PlutoLang/plutolang.github.io): `npm run gen-builtins -- "<path to docs/Runtime Environment>"`.

## Credits

This project started with the base of https://github.com/LuaLS/lua.tmbundle, which itself is based on https://github.com/textmate/lua.tmbundle.
