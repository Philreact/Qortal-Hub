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

### ✅ Untranslated pass done — 358 translations

The values that were present but still English have been translated. The bulk was
one feature: **68 `core:qortino_workspace.*` keys** — the QORTINO workspace,
EarBump music player and hotkeys panel — untranslated in five languages.

**Untranslated slots dropped 452 → 11.** Only `(key, language)` pairs actually
flagged were emitted, so existing reviewed translations in `de`/`it`/`pt` were
not overwritten.

The 11 survivors are correct as they stand: `Q-App DevNet-Testing` (×8),
`Q-Tube Tutorial`, the `qortal://APP/Name/path` URL example, and Italian
`{{ amount }} sats per KB`.

### ✅ Backfill complete — 100% key coverage

`fi`'s 61 missing keys (essentially the whole `core:message.*` subtree, from an
older `en` snapshot) and the last 45 stragglers are done: **106 translations**.

### Current state — item 4 closed

| lang                    | missing | key coverage |
| ----------------------- | ------- | ------------ |
| all 11 non-`en` locales | **0**   | **100.00%**  |

**Missing slots: 1,171 → 0.** **Untranslated: 452 → 11.**

The 11 remaining are correct as they stand — product names and format examples,
not defects: `Q-App DevNet-Testing` (×8), `Q-Tube Tutorial`, the
`qortal://APP/Name/path` URL example, and Italian `{{ amount }} sats per KB`.

**Placeholder mismatches repo-wide: 1** — the intentional Arabic singular that
omits `{{count}}`.

Note the raw audit still reports ~270 "untranslated": it counts strings that
_should_ stay English — product names (`Q-Mail`, `Q-Manager`, `Q-Chat`), URLs,
and true cognates (`Description`, `Notifications`, `options`, `Modules` in
French; `Wallets`, `Peers`, `Seedphrase` in German; `thread`, `directory` in
Italian). Do not "fix" those.

---

## 2. Files not aligned with the `en` baseline — ✅ resolved

All 72 locale files exist, and **every namespace is now aligned in every
locale**. Locales with zero missing keys:

| namespace  | before  | now            |
| ---------- | ------- | -------------- |
| `node`     | 11 / 11 | **11 / 11** ✅ |
| `question` | 11 / 11 | **11 / 11** ✅ |
| `tutorial` | 0 / 11  | **11 / 11** ✅ |
| `auth`     | 0 / 11  | **11 / 11** ✅ |
| `group`    | 0 / 11  | **11 / 11** ✅ |
| `core`     | 0 / 11  | **11 / 11** ✅ |

44 of the 66 non-English files were out of parity; none are now.

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

### ⚠️ CORRECTION, then ✅ FIXED — placeholder integrity

**The three originally reported defects were false positives.** The audit regex
`{{(\w+)}}` did not tolerate inner whitespace.

- `ar` / `fi` `group:last_message_date` were **correct**. `en` held
  `last message: {{date }}` — asymmetric spacing the regex failed to match, so
  English looked like it had no placeholder. i18next trims, so nothing broke.
- `ar` `wallet_activity_relative_minutes_ago_one` = `منذ دقيقة` ("a minute ago")
  omits `{{count}}` **deliberately**. Arabic singular does not repeat the
  numeral, and `_other` does carry `{{count}}`. Correct localisation, and the one
  remaining "mismatch" repo-wide.

**But a later repo-wide sweep found 7 genuine ones, now fixed.** The original
check only covered specific keys; scanning every key against `en` surfaced real
breakage:

| key                                               | locales                       | problem                                                     |
| ------------------------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `core:message.question.rate_app`                  | `de` `es` `fr` `ja` `ru` `zh` | referenced `{{ days }}`, absent from `en`                   |
| `question:message.error.synchronization_attempts` | `de`                          | used `{{ quantity }}` where `en` and the caller use `count` |

Both call sites of `rate_app` — `AppRating.tsx` and `AppInfo.tsx` — pass only
`rate`, so six languages rendered a literal `{{ days }}` in the app-rating
confirmation dialog. Those translations had been written against an older English
string ("N days until your next rating") that has since become "It will create a
POLL tx."; all six were rewritten to match current English. `get.ts` passes
`count`, so German rendered a literal `{{ quantity }}`.

**Repo-wide placeholder mismatches: 8 → 1** (the intentional Arabic one).

Also real, and fixed earlier: **11 asymmetric placeholders** (`{{date }}`,
`{{ quantity}}`, `{{maximum }}`) across 11 files, now normalised. The two house
styles — `{{x}}` (1,660 uses) and `{{ x }}` (1,313) — were left alone; both work,
and unifying them would be a 3,000-line diff for no functional gain.

**Lesson:** audit placeholders across every key, not just the ones being touched.
`scripts/i18n_apply_translations.py` now enforces this on write, so new
translations cannot reintroduce it — but pre-existing data needs the sweep.

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

| #   | item                                   | status                                                         |
| --- | -------------------------------------- | -------------------------------------------------------------- |
| 1   | 32 broken key references               | ✅ done — all `t()` calls resolve                              |
| 2   | placeholder integrity                  | ✅ done — 3 false positives, 7 real bugs fixed, 11 normalised  |
| 3   | casing convention                      | ✅ decided — both cases allowed; doc, skill and script aligned |
| 4   | backfill missing + untranslated keys   | ✅ done — 100% key coverage, 1,648 translations                |
| 5   | component migration (Chat, QortalLand) | ⬜ not started — 617 hardcoded strings                         |

### Item 4 — closed

| sub-item                             | result                                    |
| ------------------------------------ | ----------------------------------------- |
| 107 keys missing from all 11 locales | ✅ 1,177 translations                     |
| 452 untranslated values              | ✅ 358 translations, 11 correct survivors |
| `fi`'s 61 missing keys               | ✅ included in the final 106              |
| ~45 stragglers across the other ten  | ✅ included in the final 106              |

**1,648 translations applied in total.** Every locale is at 100% key coverage
with one intentional placeholder exception.

### Next: item 5

The only substantial i18n work left is the component migration — **617 hardcoded
strings**, 347 in `src/components/Chat/` and 270 in `src/components/QortalLand/`.
Per the `i18n` skill: migrate to `t()` first, then translate the new keys in one
batch at the end.

Worth doing first: collapse the **16 duplicated English values**, so the same
phrase is not translated four times.

### Method notes

- Emit only `(key, language)` pairs that are actually missing or untranslated.
  Applying a whole key set to every locale silently overwrites reviewed work.
- Batch by feature, not alphabetically — the `qortino_workspace` subtree
  translated as one unit keeps its terminology consistent.
- Audit placeholders across **every** key, not just the ones in flight; that is
  how the 7 real defects surfaced.
- `scripts/i18n_apply_translations.py` validates placeholders and refuses to
  write on mismatch; finish every pass with `--audit`.
