# i18n status analysis

**Snapshot:** 2026-08-08, branch `develop`. Updated after the 107-key common
backfill.

Reproduce the numbers with:

```bash
python3 scripts/i18n_apply_translations.py --audit    # untranslated values
python3 scripts/i18n_scan_hardcoded.py src            # hardcoded strings in code
```

**Baseline:** `en` holds **2,009 keys** across 6 namespaces (up from 1,990 — the
fixes below added keys).

| namespace  | keys |
| ---------- | ---- |
| `core`     | 822  |
| `group`    | 529  |
| `auth`     | 262  |
| `question` | 196  |
| `node`     | 135  |
| `tutorial` | 65   |

---

## 1. Missing translations

Two distinct failure modes, easily conflated:

- **missing key** — absent from the locale file; i18next falls back to English
- **untranslated value** — key present but the value is still the English string

### ✅ Common backfill done — 107 keys x 11 languages

The 107 keys that were missing from **every** non-English locale have been
translated and applied: **1,177 translations**, verified with 0 missing and 0
placeholder defects. Content was the calendar/event dialog (44 keys), group-call
UI (24), presence and DM friends (11), P2P health, and Reticulum group-chat
settings.

**Missing slots dropped 1,171 → 106.** No key is missing from all 11 locales any
more.

### Current state

| lang | missing | untranslated | total | key coverage |
| ---- | ------- | ------------ | ----- | ------------ |
| `zh` | 5       | 72           | 77    | 99.8%        |
| `ru` | 5       | 71           | 76    | 99.8%        |
| `ja` | 5       | 71           | 76    | 99.8%        |
| `et` | 1       | 73           | 74    | 100.0%       |
| `ar` | 3       | 71           | 74    | 99.9%        |
| `fi` | **61**  | 8            | 69    | 97.0%        |
| `fr` | 6       | 25           | 31    | 99.7%        |
| `de` | 6       | 18           | 24    | 99.7%        |
| `it` | 5       | 18           | 23    | 99.8%        |
| `es` | 5       | 13           | 18    | 99.8%        |
| `pt` | 4       | 12           | 16    | 99.8%        |

**106 missing slots** and **452 untranslated values** remain.

`fi` holds 61 of the 106 missing — one locale translated thoroughly but from an
older `en` snapshot. The other ten have 1–6 stragglers each (45 total).

The 452 untranslated collapse to roughly **106 unique keys**, so this is one
translation pass, not 452 decisions. Note the raw audit reports ~600: it counts
strings that _should_ stay English — product names (`Q-Mail`, `Q-Manager`,
`Q-Chat`), URLs, and true cognates (`port`, `admin`; `message`, `microphone`,
`Participants`, `mention` in French; `level` in German). Do not "fix" those.

---

## 2. Files not aligned with the `en` baseline

All 72 locale files exist — no locale is missing a namespace file. Alignment by
namespace, counting locales with **zero** missing keys:

| namespace  | before  | now            |
| ---------- | ------- | -------------- |
| `node`     | 11 / 11 | **11 / 11** ✅ |
| `question` | 11 / 11 | **11 / 11** ✅ |
| `tutorial` | 0 / 11  | **11 / 11** ✅ |
| `auth`     | 0 / 11  | 2 / 11         |
| `group`    | 0 / 11  | 1 / 11         |
| `core`     | 0 / 11  | 0 / 11         |

`tutorial` is now fully aligned in every locale. The remaining gap is almost
entirely `core`, and within that mostly `fi`.

### Not a defect

`ru/core.json` carries 2 keys absent from `en`:

```
account_lookup.minting_approx_few
account_lookup.minting_approx_many
```

These are correct Russian plural categories. i18next requires `few`/`many` for
Slavic languages where English needs only `one`/`other`. **Leave them.** Any
parity tooling should treat extra plural-suffix keys as valid.

---

## 3. Other issues

### ✅ FIXED — 32 keys referenced in code but absent from `en`

Resolved 2026-08-08. All `t()` calls now resolve; verification returns
`BROKEN KEY REFERENCES: none`.

The breakdown turned out to be more favourable than first assessed:

- **7 were path typos** — the key already existed elsewhere, with translations in
  all 11 languages. Fixed in code, no new keys:
  `core:message.generic.invalid_theme_format` → `core:message.error.invalid_theme_format`,
  `core:question.accept_vote_on_poll` → `core:message.question.accept_vote_on_poll`,
  `unable_download_private_app` / `unable_decrypt_app` / `unable_fetch_app` →
  their `core:message.error.*` equivalents,
  `question:message.generic.provide_key_shared_link` → `question:message.error.*`,
  and `group:message.error.decrypt_wallet` → the existing (misspelled)
  `descrypt_wallet`.
- **8 were renames** in the subscriptions UI — remapped to the existing
  `subscription.relative_*`, `by_creator`, `actions_badge`, `members` keys, which
  `SubscriptionsStatus.tsx` was already using correctly. Again no new keys.
- **17 were genuinely missing** — added to all 12 locales and translated into all
  11 languages.
- **5 `defaultValue` fallbacks removed** now that the keys exist, so the English
  is no longer hardcoded at the call site.

Remaining debt from this area: the data key `group:message.error.descrypt_wallet`
is misspelled (should be `decrypt_`), and its sibling
`group:message.generic.descrypt_wallet` too. Renaming means touching 12 locale
files plus 2 call sites — deferred, not urgent.

### ⚠️ CORRECTION — the 3 "placeholder defects" were false positives

The original finding was wrong; the audit regex `{{(\w+)}}` did not tolerate
inner whitespace.

- `ar` / `fi` `group:last_message_date` were **correct**. `en` held
  `last message: {{date }}` — asymmetric spacing the regex failed to match, so
  English looked like it had no placeholder. i18next trims, so nothing was
  actually broken.
- `ar` `wallet_activity_relative_minutes_ago_one` = `منذ دقيقة` ("a minute ago")
  omits `{{count}}` **deliberately**. Arabic singular does not repeat the
  numeral, and the `_other` form does carry `{{count}}`. Correct localisation.

What was real: **11 asymmetric placeholders** (`{{date }}`, `{{ quantity}}`,
`{{maximum }}`) across 11 files, now normalised. The two house styles — `{{x}}`
(1,660 uses) and `{{ x }}` (1,313 uses) — were left alone; both work, and
unifying them would be a 3,000-line diff for no functional gain.

### ✅ RESOLVED — casing convention

The docs and the skill claimed values are stored lowercase with capitalisation
applied via `postProcess`. The data disagreed: **819 of 1,990 `en` values started
with an uppercase letter** — `tutorial` 75%, `node` 58%, `group` 49%, `core` 42%,
`auth` 35%, `question` 3%.

**Decision: a value may start uppercase or lowercase.** Both are valid; what
matters is that the string renders correctly where it is used.

- lowercase source + `postProcess` — for short reusable labels, so one key can
  render as `Close`, `CLOSE` or `close` depending on the call site
- natural capitalization — for full sentences shown only one way

Propagated to `docs/i18n_languages.md`, the `i18n` skill, and
`scripts/i18n_apply_translations.py`.

That last one mattered: the script **hard-failed on any uppercase value**, which
under the old rule would have rejected correct German — nouns are capitalized by
orthography, so `"Wallet wird entschlüsselt..."` could never have been applied.
The lowercase check was replaced with an empty-value check.

### 🟢 16 duplicated English values

Values shared by 3 or more keys, which `docs/i18n_languages.md` asks to avoid:

- `"copy address"` × 4 — `auth:action.copy_address`, `core:message.generic.copy_address`, `group:dashboard.copy_address`, …
- `"wallet password"` × 4
- `"create account"` × 3, `"unblock"` × 3, `"backup wallet"` × 3, `"continue"` × 3, `"local node"` × 3, `"address"` × 3

### 🟢 Hardcoded strings still in components

| area                         | candidates          |
| ---------------------------- | ------------------- |
| `src/components/Chat/`       | 347 across 26 files |
| `src/components/QortalLand/` | 270 across 14 files |

Largest: `ChatGroup.tsx`, `QortalLand.tsx`, `ReticulumGroupCalendarDialog.tsx`,
`ChatDirect.tsx`, the three game dialogs. Also
`src/components/QortalLand/games/gameDialogText.ts`, which returns English
sentences from plain functions and needs restructuring to take `t` as a
parameter.

### Aside — not i18n

`src/components/UserLookup.tsx` is a **directory** containing a 78 KB
`UserLookup.tsx`. Valid, but it breaks tooling that assumes a `.tsx` path is a
file (it crashed the audit script until guarded).

---

## Progress

| #   | item                                   | status                                                                  |
| --- | -------------------------------------- | ----------------------------------------------------------------------- |
| 1   | 32 broken key references               | ✅ done — all `t()` calls resolve                                       |
| 2   | placeholder defects                    | ✅ done — 3 were false positives, 11 asymmetric placeholders normalised |
| 3   | casing convention                      | ✅ decided — both cases allowed; doc, skill and script aligned          |
| 4   | backfill missing + untranslated keys   | 🔄 in progress — common 107 done (1,177 translations)                   |
| 5   | component migration (Chat, QortalLand) | ⬜ not started — 617 hardcoded strings                                  |

### Remaining work on item 4

1. **`fi`'s 61 missing keys** — the single biggest chunk; would put every locale
   above 99.5%.
2. **~45 stragglers** across the other ten locales (1–6 each).
3. **452 untranslated values** (~106 unique keys) — one translation pass.

Use `scripts/i18n_add_keys.py` then `scripts/i18n_apply_translations.py`; the
latter validates placeholders and refuses to write on mismatch. Finish with
`--audit`.

### Then item 5

The Chat and QortalLand migration will generate new keys of its own. Per the
`i18n` skill, migrate first and translate in one batch at the end — so if that
work is imminent, it may be cheaper to do item 5 before finishing item 4's
untranslated pass.

Worth doing before either: collapse the **16 duplicated English values**, since
that removes strings from the backfill set rather than translating the same
phrase four times.
