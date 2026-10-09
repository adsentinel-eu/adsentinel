# adsentinel

Meta Ad Library ads for you and your AI agents: the AdSentinel CLI and MCP server, in one package.
Every call fetches live from the Meta Ad Library through the AdSentinel API. Docs: https://adsentinel.eu/docs/quickstart

You need an AdSentinel account: sign up at https://adsentinel.eu/signup (€2 of free credit), then sign in below.
Your credit, keys and jobs are on your dashboard, https://adsentinel.eu/dashboard (or run `adsentinel account`).

## Sign in

```
npx adsentinel login
```

It prints a link and a code. Approve the code in your browser, signed in to AdSentinel (new accounts get
€2 of free credit), and a new key is stored in `~/.config/adsentinel/credentials.json` (mode 600). In a
terminal it opens the browser and waits. An agent's shell gets the link back at once: show it to your user,
then run `adsentinel login` again to store the key. `ADSENTINEL_API_KEY` overrides the stored key. With a key
you already have: `adsentinel login --key <key>` (it then lands in your shell history).

`adsentinel topup 25` opens the dashboard's top-up for €25.

## Use it from an agent (MCP)

```json
{
  "mcpServers": {
    "adsentinel": { "command": "npx", "args": ["-y", "adsentinel", "mcp"] }
  }
}
```

It uses the stored key. On a machine without one, add `"env": {"ADSENTINEL_API_KEY": "…"}`.

In Claude Code, install the plugin instead: it adds the tools, a skill and two commands.

```
/plugin marketplace add adsentinel-eu/adsentinel
/plugin install adsentinel@adsentinel
```

## Use it from a shell, a script or cron

```
adsentinel advertiser zalando --country ES               # a name: pick the page first
adsentinel advertiser 112961202185776 --max 50           # page ids: crawl
adsentinel keyword "sneakers" --country FR --out sneakers.csv
adsentinel job <jobId> --mode full                       # re-read a result, free for 90 days
adsentinel account
```

stdout is the same compact text an agent receives. `--out <file.jsonl|file.csv>` saves the whole result and
prints only the summary header. `--json` prints the raw API envelope. Run `adsentinel --help` for every flag.

Exit codes: `0` done, `1` the API refused (the reason and what to do are on stderr), `2` usage,
`3` a name needs a human to pick the page (one or several candidates, or none) and nobody was there; a script
never crawls a guess. Agent shells (`CI`, `CLAUDECODE`, `TERM=dumb`) count as nobody, and `--no-input` forces
the same: the CLI never asks a question.

## Costs

Lookups, re-reads and cancels are free. Ads are billed per ad delivered from your prepaid credit; a job that
would cost more than your approval threshold asks first (`--approve` to confirm). Prices:
https://adsentinel.eu/pricing

AdSentinel is not affiliated with, endorsed by or sponsored by Meta Platforms, Inc.
