"""Conservative TOC recovery from searchable front-matter pages."""
from __future__ import annotations
from collections import Counter
import re

HEADER = re.compile(r'^(?:목\s*차|차\s*례|contents|table\s+of\s+contents)$', re.I)
ENTRY = re.compile(r'^(.{2,100}?)\s*(?:[.·•…_\-]{2,}\s*|\s{2,})(\d{1,5})\s*$')
SIMPLE = re.compile(r'^(.{2,80}?)\s+(\d{1,5})\s*$')


def normalize(value):
    return re.sub(r'[^\w가-힣]', '', value, flags=re.UNICODE).lower()


def parse_front_contents(text, total_pages):
    lines = [re.sub(r'\s+', ' ', line).strip() for line in text.splitlines()]
    header = next((i for i, line in enumerate(lines[:35]) if HEADER.fullmatch(line)), None)
    if header is None:
        return []
    found = []
    for line in lines[header + 1:header + 61]:
        match = ENTRY.match(line) or SIMPLE.match(line)
        if not match:
            continue
        title = match.group(1).strip(' .·•…_-')
        number = int(match.group(2))
        if 1 <= number <= total_pages and len(normalize(title)) >= 3 and not HEADER.fullmatch(title):
            found.append((title, number))
    return found[:40]


def infer_front_toc(page_count, text_at, max_front_pages=20):
    """Only emit destinations supported by matching body headings.

    text_at takes a one-based physical page index. A common printed-to-physical
    offset is reused only when at least two headings corroborate it.
    """
    front = min(max_front_pages, max(3, round(page_count * .15)), page_count)
    for toc_page in range(1, front + 1):
        entries = parse_front_contents(text_at(toc_page), page_count)
        if not entries:
            continue
        matches = {}
        for title, printed in entries:
            target = normalize(title)
            if not target:
                continue
            for actual in range(max(toc_page + 1, printed), min(page_count, printed + 30) + 1):
                if target in normalize(text_at(actual)[:1600]):
                    matches[(title, printed)] = actual
                    break
        offsets = Counter(actual - printed for (_, printed), actual in matches.items())
        common = next(((offset, count) for offset, count in offsets.most_common(1)), None)
        validated = []
        for title, printed in entries:
            actual = matches.get((title, printed))
            if actual is None and common and common[1] >= 2:
                candidate = printed + common[0]
                if toc_page < candidate <= page_count:
                    actual = candidate
            if actual is not None:
                validated.append([title, actual])
        if validated:
            return list(dict(((title, page), [title, page]) for title, page in validated).values())
    return []


def infer_split_column_toc(page_count, rows_at, text_at):
    """Handle fixed-layout EPUB contents with title and page-number columns."""
    candidates = []
    for source_page in range(1, min(page_count, 120) + 1):
        rows = rows_at(source_page)
        if not any(HEADER.fullmatch(text) or '목차' in role for text, role in rows):
            continue
        first_number = next((i for i, (text, _) in enumerate(rows)
                             if text.isdigit() and i >= 5), None)
        if first_number is None:
            continue
        titles = rows[:first_number]
        numbers = []
        for text, _ in rows[first_number:]:
            if not text.isdigit():
                break
            number = int(text)
            if not 1 <= number <= page_count:
                break
            numbers.append(number)
        if len(titles) < 5 or len(numbers) < 5 or abs(len(titles)-len(numbers)) > 4:
            continue
        for (title, role), number in zip(titles[-len(numbers):], numbers):
            if '목차' in role and len(normalize(title)) >= 3:
                candidates.append((title, number, role))
    if len(candidates) < 5:
        return []
    offsets = Counter()
    for title, printed, _ in candidates[:45]:
        key = normalize(title)
        for actual in range(printed, min(page_count, printed + 5) + 1):
            if key and key in normalize(text_at(actual)[:1800]):
                offsets[actual-printed] += 1
                break
    if not offsets or offsets.most_common(1)[0][1] < 2:
        return []
    offset = offsets.most_common(1)[0][0]
    selected = [(title, printed+offset) for title, printed, role in candidates
                if any(kind in role for kind in ('편제목', '장제목', '절제목', '내용-1-'))
                and 1 <= printed+offset <= page_count]
    selected.sort(key=lambda item: item[1])
    unique = list(dict.fromkeys(selected))
    return [[title, page] for title, page in unique[:400]]
