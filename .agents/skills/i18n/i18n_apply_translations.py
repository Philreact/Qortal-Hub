"""Apply reviewed translations to the locale files, in one batch.

Counterpart to i18n_add_keys.py. That script seeds new keys into every locale
with English placeholders; this one replaces those placeholders with the real
translations once they have been written and reviewed.

It only touches the keys named in the input, never rewriting a whole namespace,
so existing reviewed translations are never clobbered.

Usage:
    python3 .agents/skills/i18n/i18n_apply_translations.py <translations.json>
    python3 .agents/skills/i18n/i18n_apply_translations.py --audit

Input format: namespace -> language -> dotted key -> translated value.

    {
      "group": {
        "de": {
          "reticulum.expiry.no_expiry": "kein ablauf",
          "reticulum.expiry.maximum": "maximal {{duration}}"
        },
        "fi": {
          "reticulum.expiry.no_expiry": "ei vanhenemista"
        }
      }
    }

Values must keep every {{placeholder}} from the English source -- reordered
freely to suit the target language. That is enforced below; violations abort the
run before anything is written.

Casing is NOT enforced. A value may start uppercase or lowercase (see
docs/i18n_languages.md): lowercase plus a postProcess suits short reusable
labels, while natural capitalization suits full sentences -- and some languages,
German among them, capitalize nouns regardless.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# .agents/skills/i18n/<this file> -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
LOCALES = REPO_ROOT / 'src' / 'i18n' / 'locales'
PLACEHOLDER = re.compile(r'{{(\w+)}}')

# Terms that legitimately read the same in English and the target language, so
# the audit does not flag them as untranslated.
COGNATE_ALLOWLIST = {'message', 'microphone', 'maximum', 'level {{level}}'}


def sort_node(node):
    """Recursively sort dict keys — locale files are kept alphabetical at every
    level so keys are findable by eye and appends do not collide. See
    .agents/skills/i18n/i18n_sort.py."""
    if isinstance(node, dict):
        return {k: sort_node(node[k]) for k in sorted(node, key=str.lower)}
    if isinstance(node, list):
        return [sort_node(item) for item in node]
    return node


def flatten(node, prefix=''):
    flat = {}
    for key, value in node.items():
        full = f'{prefix}.{key}' if prefix else key
        if isinstance(value, dict):
            flat.update(flatten(value, full))
        else:
            flat[full] = value
    return flat


def put(node, dotted, value):
    parts = dotted.split('.')
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


def apply_translations(path_arg):
    payload = json.loads(Path(path_arg).read_text(encoding='utf-8'))

    problems = []
    for namespace, by_lang in payload.items():
        english = flatten(
            json.loads(
                (LOCALES / 'en' / f'{namespace}.json').read_text(encoding='utf-8')
            )
        )
        for lang, entries in by_lang.items():
            for key, value in entries.items():
                if key not in english:
                    problems.append(f'{lang}/{namespace}: unknown key {key}')
                    continue
                expected = set(PLACEHOLDER.findall(english[key]))
                actual = set(PLACEHOLDER.findall(value))
                if expected != actual:
                    problems.append(
                        f'{lang}/{namespace}:{key} placeholder mismatch '
                        f'{sorted(expected)} -> {sorted(actual)}'
                    )
                if not str(value).strip():
                    problems.append(f'{lang}/{namespace}:{key} is empty')

    if problems:
        print('Refusing to write, fix these first:\n')
        print('\n'.join(f'  {p}' for p in problems))
        sys.exit(1)

    written = 0
    for namespace, by_lang in payload.items():
        for lang, entries in by_lang.items():
            path = LOCALES / lang / f'{namespace}.json'
            data = json.loads(path.read_text(encoding='utf-8'))
            for key, value in entries.items():
                put(data, key, value)
            path.write_text(
                json.dumps(sort_node(data), ensure_ascii=False, indent=2) + '\n',
                encoding='utf-8',
            )
            written += len(entries)
            print(f'  {lang}/{namespace}.json: {len(entries)} keys')

    print(f'\n{written} translations applied')


def audit():
    """Report values still identical to English in a non-English locale."""
    total = 0
    for path in sorted(LOCALES.glob('*/*.json')):
        lang = path.parent.name
        if lang == 'en':
            continue
        english = flatten(
            json.loads((LOCALES / 'en' / path.name).read_text(encoding='utf-8'))
        )
        same = [
            key
            for key, value in flatten(
                json.loads(path.read_text(encoding='utf-8'))
            ).items()
            if key in english
            and value == english[key]
            and len(str(value)) > 3
            and str(value) not in COGNATE_ALLOWLIST
        ]
        if same:
            total += len(same)
            print(f'{lang}/{path.name}: {len(same)} untranslated')
    print(
        f'\n{total} values still match English.'
        if total
        else '\nNo untranslated values found.'
    )
    print('Note: genuine cognates may appear here; confirm before "fixing" them.')


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('translations', nargs='?', help='JSON file of translations')
    parser.add_argument(
        '--audit',
        action='store_true',
        help='list values still identical to English instead of writing',
    )
    args = parser.parse_args()

    if args.audit:
        audit()
    elif args.translations:
        apply_translations(args.translations)
    else:
        parser.error('provide a translations file or --audit')


if __name__ == '__main__':
    main()
