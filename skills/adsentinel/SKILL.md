---
name: adsentinel
description: Use when the user wants ads from the Meta (Facebook/Instagram) Ad Library: what a brand is running, who advertises on a topic, ad counts, launches, formats, through the AdSentinel tools or the `adsentinel` CLI.
---

# Getting Meta Ad Library ads with AdSentinel

The AdSentinel tools fetch ads live from the Meta Ad Library. Lookups are free; ads are billed per ad from the
user's prepaid credit. Every answer starts with `next`: read it first and do what it says.

## 1. Resolve the advertiser with the user, never alone

- With a brand name or a website, call `find_advertiser` (free). Pass `country` when the user named a market.
- Show the user the candidates and **wait for their choice**, even when one is ranked first, verified or
  `proposed`. A wrong page silently returns another company's ads.
- For a regional family, show the `proposed` members for the market and ask the user to confirm the set.
- Only then call `get_advertiser_ads` with the confirmed page id(s). Skip the question only if the user gave
  the page id or already confirmed this page in this conversation.
- `country` is where the ad was shown, never where the advertiser is.

## 2. Read small first

- Ask for `mode: "extra-compact"` first: the summary header plus one row per ad and its copy, about 100 tokens
  per ad. Re-read the same job with `get_job` in `mode: "full"` only for the ads that matter. Re-reading a job
  never bills again (results stay readable for 90 days).
- For "who advertises on X", call `get_keyword_ads` with a modest `maxAds` and `inlineTokens: 0`: the header's
  advertiser list is the answer.

## 3. Money: ask before spending more

- On `approval_required`, nothing was crawled or charged. Tell the user the amount and ask. Only if they agree,
  call again with the same arguments plus `approved: true`.
- Never set `maxAds: "all"` unless the user asked for everything and knows it costs more.
- On the monthly plan, to update ads the user already has, offer `refresh_ads` (it bills only the ads named)
  rather than re-running the advertiser, which bills every ad again.
- A result whose `next` starts with `PARTIAL RESULT:` is incomplete: tell the user what is missing.

## 4. Large pulls: use the CLI with --out

In Claude Code, for hundreds of ads or a file the user wants to keep, run the CLI and save to a file so the
rows never enter the conversation. Pin the version:

```
npx -y adsentinel@0.1.1 advertiser <pageId[,pageId...]> --country XX --max 1000 --out ads.csv
npx -y adsentinel@0.1.1 keyword "<keyword>" --country XX --out ads.jsonl
```

- The CLI waits until the job ends, which can take minutes: run it in the background or with a long Bash
  timeout (the default is 2 minutes).
- If the command was cut off, the job is still running. Its id is on the first stderr line; read it again with
  `npx -y adsentinel@0.1.1 job <jobId> --out <file>` (free). Never submit the pull again.
- It prints only the summary header. Read the file with a script if the user needs numbers from it.
- On `no_api_key`: the plugin's key field reaches the tools, not the CLI. Do not retry. Ask the user to run
  `npx adsentinel login` in a terminal outside Claude Code (it asks for the key, checks it and stores it), or
  to export `ADSENTINEL_API_KEY` before starting Claude Code. Inside Claude Code the CLI never asks questions.
- After the user logs in, call the tool again: the tools read the stored key on every call, so no restart is needed
  (an MCP server older than 0.1.1 needs `/mcp`, then reconnect adsentinel). Their account is at
  https://adsentinel.eu/dashboard.
