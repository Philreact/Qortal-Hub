"""Find hardcoded user-visible strings that should go through i18next.

Reports quoted string literals, JSX text and JSX *attributes*. Accessibility and
form strings -- aria-label, label, placeholder, title, alt, helperText -- are the
category most often missed during a migration, so they are reported alongside the
other two.

Usage:
    python3 .agents/skills/i18n/i18n_scan_hardcoded.py                       # whole src tree
    python3 .agents/skills/i18n/i18n_scan_hardcoded.py src/components/Chat    # one directory
    python3 .agents/skills/i18n/i18n_scan_hardcoded.py --detail src/components/Chat/ChatGroup.tsx
    python3 .agents/skills/i18n/i18n_scan_hardcoded.py -o report.json src/

Counts are candidates, not confirmed defects -- a string may legitimately be a
CSS value, an API field or a log message. Read the hits before acting on them.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# .agents/skills/i18n/<this file> -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]

ATTRS = 'aria-label|label|placeholder|title|alt|helperText|tooltip|titleAccess'
ATTR_RE = re.compile(
    rf'\b(?:{ATTRS})=(?:"([^"]{{2,}})"|\{{\s*[\'"]([^\'"]{{2,}})[\'"]\s*\}})'
)
JSX_RE = re.compile(r'>\s*([A-Z][A-Za-z0-9][^<>{}\n]{3,})\s*<')
STR_RE = re.compile(
    r'[\'"]([A-Z][a-z]+(?:\s+[A-Za-z0-9\'".,!?()-]+){1,}[.!?]?)[\'"]'
)

SKIP_VALUE = re.compile(r'^(https?:|/|#|[A-Z_]+$)')
SKIP_LINE = re.compile(
    r'console\.|executeEvent|subscribeToEvent|unsubscribeFromEvent|'
    r'data-testid|import\s|require\('
)
CSS_ISH = re.compile(r'\b(px|rem|em|solid|dashed|rgba?\(|translate|calc\()')
EXCLUDE_DIRS = {'node_modules', 'dist', 'build', '.git'}


def scan_file(path: Path):
    hits = []
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except (UnicodeDecodeError, OSError):
        return hits

    for number, line in enumerate(lines, 1):
        stripped = line.strip()
        if stripped.startswith(('//', '*', '/*')) or SKIP_LINE.search(line):
            continue

        # One entry per distinct string on the line. An attribute value also
        # matches the generic string-literal pattern, so the more specific kind
        # wins rather than the string being reported twice.
        found = {}
        for match in STR_RE.finditer(line):
            value = match.group(1)
            if ' ' in value and not SKIP_VALUE.match(value) and not CSS_ISH.search(value):
                found[value] = 'str'
        for match in JSX_RE.finditer(line):
            value = match.group(1).strip()
            if value and not SKIP_VALUE.match(value):
                found[value] = 'jsx'
        for match in ATTR_RE.finditer(line):
            value = match.group(1) or match.group(2)
            if value and not SKIP_VALUE.match(value) and re.search(r'[a-z]', value):
                found[value] = 'attr'

        for value, kind in sorted(found.items()):
            hits.append({'line': number, 'kind': kind, 'text': value})
    return hits


def iter_sources(target: Path):
    if target.is_file():
        yield target
        return
    for path in sorted(target.rglob('*')):
        if path.suffix not in ('.ts', '.tsx'):
            continue
        if set(path.parts) & EXCLUDE_DIRS or '.test.' in path.name:
            continue
        yield path


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('target', nargs='?', default='src', help='file or directory')
    parser.add_argument('--detail', action='store_true', help='print every hit')
    parser.add_argument('-o', '--output', help='write full results to a JSON file')
    args = parser.parse_args()

    target = Path(args.target)
    if not target.is_absolute():
        target = REPO_ROOT / target
    if not target.exists():
        sys.exit(f'no such path: {target}')

    report, total = {}, 0
    for path in iter_sources(target):
        hits = scan_file(path)
        if not hits:
            continue
        rel = str(path.relative_to(REPO_ROOT))
        report[rel] = hits
        total += len(hits)

    for rel, hits in sorted(report.items(), key=lambda kv: -len(kv[1])):
        print(f'{len(hits):5d}  {rel}')
        if args.detail:
            for hit in hits:
                print(f"       {hit['line']:5d} {hit['kind']:4s} {hit['text'][:88]}")

    if total:
        print(f'\n{total} candidates across {len(report)} files')
    else:
        print(f'No hardcoded strings found in {target.relative_to(REPO_ROOT)}')

    if args.output:
        Path(args.output).write_text(
            json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8'
        )
        print(f'Report written to {args.output}')


if __name__ == '__main__':
    main()
