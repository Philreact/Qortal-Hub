---
name: i18n
description: Rules for user-visible text in Qortal Hub. Read BEFORE writing or editing any component, dialog, menu, toast, tooltip, aria-label, placeholder, or error message. Every user-facing string must go through i18next — never hardcode English. Triggers on any UI work, any new component, any string a user could read.
---

# i18n is mandatory for every user-visible string

Qortal Hub ships in 12 languages. A hardcoded English literal is a bug, not a
shortcut. This applies to **new code and to any line you touch in existing code**.

## What counts as user-visible

Translate all of these — the last three are the ones most often missed:

- JSX text content, `Typography`, `Button`, `MenuItem` children
- `label`, `placeholder`, `title`, `helperText`, `alt`
- **`aria-label` and every other accessibility string**
- **Error and status messages**, including ones thrown/rejected from async code
- **Strings built in plain `.ts` helper modules** that end up on screen

Do NOT translate: log messages, event names passed to `executeEvent` /
`subscribeToEvent`, API field names, test fixtures, `data-*` attributes.

## The pattern in components

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation(['auth', 'core', 'group', 'question', 'tutorial']);

<Button>{t('core:action.close', { postProcess: 'capitalizeFirstChar' })}</Button>
```

Declare only the namespaces the component actually uses. Always prefix the key
with its namespace (`core:`, `group:`, …) — the default namespace is `core`, but
be explicit anyway.

## The pattern outside components

Non-React modules import the instance directly rather than using the hook:

```ts
import i18n from '../i18n/i18n';

throw new Error(
  i18n.t('auth:message.error.invalid_uint8', { postProcess: 'capitalizeFirstChar' })
);
```

For pure helper modules that return display text (see
`src/components/QortalLand/games/gameDialogText.ts` for the anti-pattern), prefer
**taking `t` as a parameter** so the caller's namespaces and language reactivity
apply. Return a key + params object instead of a sentence when that is cleaner.

## Casing is done by post-processors, not by the source string

Values in the JSON files are stored **lowercase**. Casing is applied at render
time via `postProcess`. Never capitalize inside the JSON, and never do
`t(...).toUpperCase()` in JSX.

Available processors (see `src/i18n/processors.ts`):

| Processor | Effect |
|---|---|
| `capitalizeFirstChar` | `close` → `Close` — the default choice |
| `capitalizeFirstWord` | first word uppercased entirely |
| `capitalizeEachFirstChar` | Title Case |
| `capitalizeSentenceStarts` | capitalizes after `.`/`!`/`?` and newlines |
| `capitalizeAll` | ALL CAPS — for stat labels and similar |

## Adding a new key

1. Add it to `src/i18n/locales/en/<namespace>.json`, lowercase, nested by topic.
2. **Add the same key to all 12 locale dirs** under `src/i18n/locales/` — `ar`,
   `de`, `en`, `es`, `et`, `fi`, `fr`, `it`, `ja`, `pt`, `ru`, `zh`. Every locale
   must carry the identical key set and the identical file set
   (`auth`, `core`, `group`, `node`, `question`, `tutorial`). English text is an
   acceptable placeholder for a language you cannot translate — a *missing* key
   is not.
3. Pick the namespace by domain: `core` for shared UI vocabulary and generic
   messages, `group` for group/chat/Reticulum features, `auth`, `node`,
   `question`, `tutorial` for their own areas.

Adding a *new* namespace also requires registering it in the `namespaces` array
in `src/i18n/i18n.ts` — the locale files are glob-loaded, but the namespace list
is explicit.

## Key naming

Follow the existing shape in the JSON files:

- Actions: `core:action.close`, `core:action.add_reaction`
- Errors: `core:message.error.generic`, `group:message.error.qortals_required`
- Questions/confirms: `core:message.question.delete_chat_image`
- Plurals: base key plus `_other` (`core:admin` / `core:admin_other`) — i18next
  selects via the `count` option.

Use `snake_case`, no abbreviations, name by meaning rather than by the English
wording so the key survives a copy edit.

## Interpolation

```tsx
t('group:message.error.qortals_required', {
  quantity: 4,
  postProcess: 'capitalizeFirstChar',
})
```

Never concatenate translated fragments to build a sentence — word order differs
across languages. Put the whole sentence in one key with placeholders.

## Known gaps — do not imitate the neighbours

Large parts of the newer UI were written **without** i18n and are being migrated:

- Most `Reticulum*` components in `src/components/Chat/`
- The whole of `src/components/QortalLand/` (including `games/` and `proximity/`)
- Leftover literals inside otherwise-translated files such as `ChatGroup.tsx`
  and `MessageItem.tsx`

"Match the surrounding code" does not apply here. When editing these files, use
`t()` for the lines you touch, and mention any remaining hardcoded strings you
noticed rather than silently leaving them.

## Before you finish

Re-read your diff for quoted English. A quick check:

```bash
grep -nE '(aria-)?label="[A-Za-z]|placeholder="[A-Za-z]|title="[A-Za-z]|>[A-Z][a-z]+ ' <file>
```

Anything it returns that a user can read must be a `t()` call.
