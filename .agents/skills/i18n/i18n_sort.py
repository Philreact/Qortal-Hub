"""Sort every locale file alphabetically, at every nesting level.

Sorted files make a key easy to find by eye, keep siblings together, and stop
merge conflicts from two people appending to the same spot. `i18n_add_keys.py`
and `i18n_apply_translations.py` sort on write, so the tree stays sorted; this
script is for a one-off pass or a CI check.

Usage:
    python3 .agents/skills/i18n/i18n_sort.py            # sort in place
    python3 .agents/skills/i18n/i18n_sort.py --check    # exit 1 if anything is unsorted

Sorting is key-order only: no key is added, removed or renamed, and no value is
touched. The script verifies that itself before writing.
"""

import argparse
import json
import sys
from pathlib import Path

# .agents/skills/i18n/<this file> -> repo root
def _find_repo_root(start: Path) -> Path:
    for parent in [start, *start.parents]:
        if (parent / 'src' / 'i18n' / 'locales').is_dir():
            return parent
    return start.parents[2]


REPO_ROOT = _find_repo_root(Path(__file__).resolve().parent)
LOCALES = REPO_ROOT / 'src' / 'i18n' / 'locales'


def sort_node(node):
    """Recursively sort dict keys. Lists keep their order — it is meaningful."""
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


def dump(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument(
        '--check',
        action='store_true',
        help='report unsorted files and exit 1 instead of rewriting them',
    )
    args = parser.parse_args()

    unsorted_files = []
    for path in sorted(LOCALES.glob('*/*.json')):
        original = json.loads(path.read_text(encoding='utf-8'))
        ordered = sort_node(original)

        # Sorting must be order-only: same keys, same values.
        before, after = flatten(original), flatten(ordered)
        if before != after:
            sys.exit(f'ABORT: {path} content would change — refusing to write')

        if dump(ordered) == path.read_text(encoding='utf-8'):
            continue

        unsorted_files.append(path.relative_to(REPO_ROOT))
        if not args.check:
            path.write_text(dump(ordered), encoding='utf-8')

    if args.check:
        if unsorted_files:
            print(f'{len(unsorted_files)} locale files are not sorted:')
            for f in unsorted_files:
                print(f'  {f}')
            print('\nRun: python3 .agents/skills/i18n/i18n_sort.py')
            sys.exit(1)
        print('All locale files are sorted.')
    else:
        print(f'{len(unsorted_files)} files sorted' if unsorted_files else 'Already sorted.')


if __name__ == '__main__':
    main()
