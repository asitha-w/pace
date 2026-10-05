# Install

pace is a Claude Code plugin: a folder with a manifest and one hooks module. Two documented ways
to load it.

**As a plugin, with versions and updates.** The repo is its own marketplace:

```sh
claude plugin marketplace add asitha-w/pace
claude plugin install pace@asitha-w
```

Later, `claude plugin update pace@asitha-w` picks up a new version.

**In place, from a folder.** Claude Code loads any plugin folder under `~/.claude/skills/` (or a
project's `.claude/skills/`) as `<name>@skills-dir`, no install step:

```sh
git clone https://github.com/asitha-w/pace.git ~/.claude/skills/pace
```

Edits to that folder take effect at the next session or after `/reload-plugins`.

Either way, pace loads in the next session. The settings dialog at first load has a default for
every value, so Enter through it works; [settings.md](settings.md) says what each one moves.
Built and tested on Claude Code 2.1.289.

## Development

```sh
claude plugin validate .
claude plugin test .
```

`validate` prints every hook the module registers and every engine call it makes: files, processes,
network, model. That listing is the thing to read before loading any plugin you did not write.
Design and the reasoning behind each threshold: [DESIGN.md](../DESIGN.md).

## Extending

pace adds a `$.pace` noun with four events: `pace.signal`, `pace.targets`, `pace.park` and
`pace.now`. Another plugin that lists `"dependencies": ["pace"]` can log or reword signals, add park
targets such as an issue tracker, or read the figures. The contract is
[`types/index.d.ts`](../types/index.d.ts).

[Cairn](https://github.com/asitha-w/cairn) (`crn`) is the sister project: pace tells you when to
leave a session, Cairn remembers where the work stands so the next one starts small. They connect
through this contract and neither depends on the other.
