# hqd-toolkits

`hqd-toolkits` is a Node.js command-line toolkit for developer workflows. It provides:

- `knowledge` to install, inspect, diagnose, or safely remove a project’s Codex + MCP Memory + Obsidian knowledge workflow.
- `stripe` to list and run Stripe-related shell scripts supplied by the package or the user.

## Requirements

- Node.js 22 or newer, with npm and `npx`.
- Bash 4 or newer; `hqd-toolkits stripe` uses this when listing available scripts.
- Linux or macOS.
- For the AI workflow, install the Codex CLI and AgentKit (`ak`) by following the [Codex CLI documentation](https://developers.openai.com/codex/cli/) and [AgentKit installation documentation](https://docs.agentkit.best/en/stable/getting-started/installation).
- For `knowledge install`, no Obsidian app or vault setup is required. The installer creates a filesystem vault by default; `--vault` can point to an existing vault.
- For Stripe workflows, install and authenticate the Stripe CLI and install `jq`; refer to the [Stripe CLI documentation](https://docs.stripe.com/stripe-cli).

## Install

Install the published package globally:

```bash
npm install -g hqd-toolkits
hqd-toolkits --help
```

### What installation changes

`npm install -g hqd-toolkits` installs the package under npm's global prefix and exposes the `hqd-toolkits` command in `<prefix>/bin/`. When npm allows lifecycle scripts, the package's `postinstall` hook also copies the bundled extensions into `~/.hqd/` by default, or into the directory set by `HQD_HOME`:

- `commands/knowledge.sh` and `commands/stripe.sh` to `~/.hqd/commands/` (or `$HQD_HOME/commands/`).
- The knowledge manager and Stripe scripts to their matching paths under `~/.hqd/scripts/` (or `$HQD_HOME/scripts/`).

This extension directory is separate from the npm package location. If npm is configured to ignore or block install scripts, the package and command are installed but the extension copies are not created or upgraded.

The hook records hashes and ownership in `~/.hqd/state/extensions/receipt.json` (or `$HQD_HOME/state/extensions/receipt.json`). On a later package install, it upgrades unchanged copies it owns and recognized copies from a known earlier release. It preserves modified, custom, and unknown same-name files and warns that they continue to take precedence over the bundled copy. The npm package's own files live under npm's install directory; removing the npm package does not remove the extension copies.

Installing the npm package does not install a project's knowledge workflow or create notes. Run `hqd-toolkits knowledge install` from the target project to do that. It adds managed content to `AGENTS.md` and `.codex/config.toml`, creates the `knowledge-sync` files under `.agents/skills/`, and records its project state under `.hqd-knowledge/`. It creates the configured Memory JSONL file only if it does not already exist, and creates `Projects/<project-slug>/Knowledge/` under the configured vault. Existing Memory file contents are left as-is.

The default data root is `${XDG_DATA_HOME}/hqd-toolkits` when `XDG_DATA_HOME` is an absolute path; when unset or relative, the installer uses `$HOME/.local/share/hqd-toolkits`. The default Memory file is `agent-memory/<project-slug>/memory.jsonl`, and the default filesystem vault is `agent-knowledge`. Pass `--memory PATH` or `--vault PATH` independently to choose either location. Absolute resolved paths are saved in a private per-user receipt and reused by status, doctor, recovery, and uninstall. Changing `XDG_DATA_HOME` or passing different paths later does not relocate an existing installation. No legacy Memory or vault content is migrated; copy it manually after making a backup if you want to move it. Data in the local XDG directory is not automatically backed up or synchronized, so configure your own backup/sync or select a synchronized vault with `--vault`.

The project integration refuses to overwrite an existing `.hqd-knowledge` state directory, generated skill files, or ambiguous managed blocks. Existing text outside the managed blocks in `AGENTS.md` and `.codex/config.toml` is retained. Uninstall removes only unchanged installer-owned files and blocks; Memory and Obsidian runtime data are preserved by default. Empty installer-created runtime data can be purged only with `--purge-empty-data` and matching `--memory` and `--vault` paths. Modified files, edited blocks, and non-empty directories are preserved.

## Commands

### Knowledge workflow

From the project where you want the workflow installed, run:

```bash
hqd-toolkits knowledge install \
  --project-slug my-project \
  --vault "$HOME/Documents/Obsidian/DevKnowledge"
```

The slug defaults to the project directory name. Both `--vault` and `--memory` are optional and independent. For example, this uses the default Memory location and an existing Obsidian vault:

```bash
hqd-toolkits knowledge install --vault "$HOME/Documents/Obsidian/DevKnowledge"
```

Without either override, Memory uses `${XDG_DATA_HOME:-$HOME/.local/share}/hqd-toolkits/agent-memory/<project-slug>/memory.jsonl` and the vault uses `${XDG_DATA_HOME:-$HOME/.local/share}/hqd-toolkits/agent-knowledge`. A relative `XDG_DATA_HOME` is ignored in favor of `$HOME/.local/share`.

Check the installation and its dependencies with:

```bash
hqd-toolkits knowledge status
hqd-toolkits knowledge doctor
```

Remove the project integration with:

```bash
hqd-toolkits knowledge uninstall
```

The manager rejects symlinks in managed paths, takes a per-project mutation lock, and keeps a private recovery journal under `$HQD_HOME/state/knowledge/`. A failed install rolls back changes it can still identify exactly. If a path changed during rollback, it is preserved and the manager reports `recovery_required`; rerun the same install command to recover a complete rollback. A lock is never removed automatically as stale: check its recorded PID before manual cleanup.

Uninstall validates the complete manifest against a private per-user ownership receipt before changing files. It removes only exact, unchanged generated files and complete, unchanged managed blocks. Legacy schema-v1 state is parsed without evaluating shell text, but cleanup is disabled if the install has no trusted receipt; review those files manually. Memory and Obsidian runtime data are preserved by default. To purge installer-created empty runtime data, pass `--purge-empty-data` with the canonical selectors recorded at install:

```bash
hqd-toolkits knowledge uninstall \
  --purge-empty-data \
  --memory "${XDG_DATA_HOME:-$HOME/.local/share}/hqd-toolkits/agent-memory/my-project/memory.jsonl" \
  --vault "${XDG_DATA_HOME:-$HOME/.local/share}/hqd-toolkits/agent-knowledge"
```

The selectors must match the trusted receipt. Modified files, edited blocks, and non-empty directories are preserved. Purging never recursively deletes notes or a non-empty vault. If `XDG_DATA_HOME` is unset, use `$HOME/.local/share` in the example paths.

Knowledge workflows use filesystem operations for ordinary note reads, writes, and search, so they work without Obsidian, a GUI, an API key, or a REST plugin. Filesystem `search_files` matches paths and filenames; use `rg` or equivalent content search for full-text search. Obsidian CLI is optional for app-native commands, while REST is optional for plugin-specific operations such as Dataview DQL or active-file control. Keep concurrent note writes on separate files or serialize writes to the same note, and route Memory edits through the configured Memory MCP service.

Run `hqd-toolkits knowledge --help` for all options, including `--project-dir`, the default paths, and independent `--memory`/`--vault` overrides.

### Stripe scripts

List available scripts or run one by name:

```bash
hqd-toolkits stripe
hqd-toolkits stripe example --dry-run
```

Scripts in `~/.hqd/scripts/stripe/` take precedence over bundled scripts with the same name. Arguments after the script name are forwarded to that script. The bundled `check_multi_customers` script follows Stripe subscription pages and reports `inactive` only after every page completed successfully without an active or trialing subscription. It validates Stripe JSON with `jq`; provider, parsing, and pagination errors return nonzero without an inactive result. The bundled `example` script is a placeholder, not a Stripe integration.

### User commands

Add custom commands as `~/.hqd/commands/<name>.sh`. Each command script defines a `run` function; an optional `DESCRIPTION` is shown by `hqd-toolkits --help`. A user command with the same name takes precedence over a bundled command.

For example:

```bash
mkdir -p ~/.hqd/commands
cat > ~/.hqd/commands/hello.sh <<'EOF'
DESCRIPTION="Print a greeting"
run() {
  echo "Hello $*"
}
EOF
chmod +x ~/.hqd/commands/hello.sh
hqd-toolkits hello world
```

The package also keeps its built-in commands and scripts and can use them directly. The install hook records ownership in a private receipt under `~/.hqd/state/extensions/`. It atomically upgrades unchanged package-managed copies and known copies from the prior package release. Modified or unknown same-name files are preserved and reported; they continue to shadow the bundled script until you choose to update or remove them. Files copied into `~/.hqd` remain there if you later uninstall the npm package.

## Development

```bash
npm test
npm pack --dry-run
```

The package smoke check is also run automatically before packaging.

## License

[MIT](LICENSE)
