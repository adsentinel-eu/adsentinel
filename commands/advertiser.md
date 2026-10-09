---
description: Get the ads a brand runs in the Meta Ad Library (you confirm the page first)
argument-hint: <brand or website> [country]
---

Use the adsentinel skill. Arguments: $ARGUMENTS (a brand or website, then an optional two-letter country code).

1. Call `find_advertiser` with the brand from the arguments (and the country, if given).
2. Show the candidates and ask which page they mean (for a family, the proposed members for the market). Wait.
3. Call `get_advertiser_ads` with the confirmed page id(s), `mode: "extra-compact"`, and the country if given.
4. Summarise the header for the user (ads, active, launches by week, formats, landing domains, longest running),
   then offer to read specific ads in full.
