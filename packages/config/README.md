# @ion/config

Files ion reads and writes. Config lives in files; work lives in events.

- `ionPaths(env)` → `{ configFile, dataDir }`. `ION_HOME` overrides; else XDG; else `~/.config/ion` and
  `~/.local/share/ion`.
- `loadUserConfig(file)` → `{ config, error }`. A missing file gives defaults; a broken one gives defaults
  plus one line like `config.toml: ion.deepEffort must be one of low, medium, high, max`.
- `saveUserConfig(file, config)` writes atomically.
- `addProject(config, path)` returns a new config. Errors: `Not a git repository: <path>`,
  `Already added: <id>`.

```toml
[ion]
quick = "claude-code:Haiku 5.5"   # Quick model
deep = "claude-code:Opus 5.5"     # Deep model
deepEffort = "high"               # low | medium | high | max
useDeep = "auto"                  # auto | always | never

[[projects]]
id = "storefront"
path = "/Users/me/code/storefront"
starred = true
```
