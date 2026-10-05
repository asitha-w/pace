# Install

pace is a Claude Code mod: a plugin folder with a manifest and one hooks module. Point Claude Code
at this repo and it knows what to do. By hand, either of these:

```sh
git clone https://github.com/asitha-w/pace.git
ln -s "$PWD/pace" ~/.claude/skills/pace      # loads in every session as pace@skills-dir
```

```sh
claude --plugin-dir ./pace                   # one session only
```

Requires Claude Code 2.1.287 or later. The settings dialog at first load has a default for every
value, so Enter through it works; see [settings.md](settings.md) to change them later.

## Development

```sh
claude plugin validate .
claude plugin test .
```

Design and the reasoning behind each threshold: [DESIGN.md](../DESIGN.md).

## Extending

pace adds a `$.pace` noun with four events: `pace.signal`, `pace.targets`, `pace.park` and
`pace.now`. Another mod that lists `"dependencies": ["pace"]` can log or reword signals, add park
targets such as an issue tracker, or read the figures. The contract is
[`types/index.d.ts`](../types/index.d.ts).

[Cairn](https://github.com/asitha-w/cairn) (`crn`) is the sister project: pace tells you when to
leave a session, Cairn remembers where the work stands so the next one starts small. They connect
through this contract and neither depends on the other.
