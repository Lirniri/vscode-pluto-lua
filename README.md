# Pluto Syntax Highlighting

For information regarding the installation, features, & usage of this editor integration, [have a look at our documentation](https://plutolang.github.io/docs/Editor%20Integration).

## Features in Visual Studio Code

Besides syntax highlighting and snippets, the VS Code extension provides language features for `.pluto` files:

- **Completion** for Pluto keywords, the standard library (`string.split`, `table.contains`, `io.listdir`, `json.encode`, ...), built-in modules (`require "pluto:json"`), and everything declared in your workspace: classes, methods, fields, functions with their parameters and type hints, enums, and module ids from `info.json` manifests.
- **Hover** with the signature, the comment written above the declaration, the file it comes from and, for functions and methods, their source code in a compact form (comments removed, indentation normalized, logical blocks separated by blank lines; see `pluto.hover.showFunctionBody` and `pluto.hover.maxBodyLines`). Hovering a return type (`void` in `function f(): void`) also shows what the developer wrote in an `@return` comment, above the function or inside of its body, e.g. `-- @return bool Whether it worked`; the same lines are part of the function's hover and signature help.
- **Signature help** when typing `(`, highlighting the current argument.
- **Go to Definition** (`F12` / `Ctrl+Click`) for classes, methods, functions, variables, and the file behind `require("...")`.
- **Outline & breadcrumbs**, **Go to Symbol in Workspace** (`Ctrl+T`), and **folding** of blocks, comments and `--#region` markers.
- **Type hints**: typing `:` in `function f(a: `, `function f(): ` or `local x: ` opens the list of types (built-in types and your classes, each also as nullable `int?`); nullable types are highlighted and explained on hover (`(nullable type) int? — Can be int or nil`), also in signature help. Both spellings, `int?` and `?int`, are understood.
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
| `pluto.workspace.ignoreFiles` | `[".gitignore", ".plutoignore"]` | Ignore files (`.gitignore` syntax) in the workspace root to read exclusions from. |
| `pluto.workspace.exclude` | `[]` | Glob patterns to leave out of the index, e.g. `**/vendor/**`. |
| `pluto.workspace.useSearchExclude` | `true` | Also apply `search.exclude`. `files.exclude` always applies. |
| `pluto.index.maxFiles` | `5000` | Maximum number of files to index. |
| `pluto.completion.keywords` | `true` | Suggest keywords. |
| `pluto.completion.documentWords` | `true` | Suggest other words of the current document. |
| `pluto.completion.autoTriggerTypes` | `true` | Open the list of types by itself after `:` in type hints (`a: `, `): `, `local x: `), in Pluto files only. |
| `pluto.highlight.nullableTypes` | `true` | Highlight nullable types (`int?`, `?string`, `Vehicle?`). |
| `pluto.highlight.nullableTypeColor` | `#FFFFFF` | Their color in dark and high contrast themes. |
| `pluto.highlight.nullableTypeLightColor` | `#000000` | Their color in light themes. |
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

### Commands

- **Pluto: Run Script** — runs the current file with `pluto`.
- **Pluto: Lint Script** — checks the current file with `plutoc -p`.
- **Pluto: Rebuild Workspace Index**

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

- Open this folder in VS Code and press `F5` to try the extension in a new window.
- `npm test` runs the grammar tests and the language feature tests.
- `npm run package` builds a `.vsix`, which can be installed with `code --install-extension <file>.vsix`.
- `src/builtins.generated.json` is generated from [the Pluto documentation](https://github.com/PlutoLang/plutolang.github.io): `npm run gen-builtins -- "<path to docs/Runtime Environment>"`.

## Credits

This project started with the base of https://github.com/LuaLS/lua.tmbundle, which itself is based on https://github.com/textmate/lua.tmbundle.
