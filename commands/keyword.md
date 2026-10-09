---
description: Find ads matching a keyword in the Meta Ad Library, with every advertiser listed
argument-hint: <keyword> [country]
---

Use the adsentinel skill. Arguments: $ARGUMENTS (a keyword, then an optional two-letter country code).

1. Call `get_keyword_ads` with the keyword from the arguments, the country if given, `mode: "extra-compact"` and `maxAds: 100`.
2. Lead with the header's advertiser breakdown (who advertises on it, with ad counts), then the notable ads.
3. If `approval_required` comes back, tell the user the amount and ask before calling again with `approved: true`.
