#!/usr/bin/env python3
"""Append selected October CSV days to the production quiz datasets."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
from pathlib import Path


COURSES = ("clacel", "toeic", "ielts")


def clean_markup(value: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def build_item(course: str, day: int, index: int, row: dict[str, str]) -> dict[str, str]:
    example_markup = row["example_draft"].strip()
    match = re.search(r"<i>(.*?)</i>", example_markup, flags=re.IGNORECASE | re.DOTALL)
    if not match:
        raise ValueError(f"{course} Day {day} #{index}: 例文中の正答マークがありません")
    answer = clean_markup(match.group(1))
    sentence = clean_markup(example_markup[: match.start()] + "___" + example_markup[match.end() :])
    base = clean_markup(row["headword"])
    meaning = clean_markup(row["meaning_draft"])
    translation = clean_markup(row["translation_draft"])
    if not all((answer, sentence, base, meaning, translation)):
        raise ValueError(f"{course} Day {day} #{index}: 必須項目が不足しています")
    return {
        "questionId": f"2026-10/{course}/day{day:02d}/q{index:02d}",
        "sentence": sentence,
        "answer": answer,
        "base": base,
        "hint": base[0] + "_" * (len(base) - 1),
        "ja": meaning,
        "sentenceJa": translation,
    }


def load_days(source: Path, course: str, selected_days: set[int]) -> list[dict]:
    by_day: dict[int, list[dict[str, str]]] = {day: [] for day in selected_days}
    with source.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            match = re.fullmatch(r"Day (\d+)", row["day"].strip())
            if not match:
                continue
            day = int(match.group(1))
            if day in by_day:
                by_day[day].append(row)
    series = []
    for day in sorted(selected_days):
        rows = sorted(by_day[day], key=lambda row: int(row["order"]))
        if len(rows) != 20:
            raise ValueError(f"{course} Day {day}: 20問ではありません ({len(rows)}問)")
        series.append({
            "name": f"Day {day}",
            "day": day,
            "items": [build_item(course, day, index, row) for index, row in enumerate(rows, 1)],
        })
    return series


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--days", nargs="+", required=True, type=int)
    args = parser.parse_args()
    selected_days = set(args.days)

    for course in COURSES:
        label = "Clacel" if course == "clacel" else course.upper()
        source = args.source_dir / f"{label}_2026-10_monthly_native_review_source_v09.csv"
        destination = args.data_dir / f"{course}-2026-09.json"
        data = json.loads(destination.read_text(encoding="utf-8"))
        replacements = {entry["day"]: entry for entry in load_days(source, course, selected_days)}
        data["series"] = sorted(
            [entry for entry in data["series"] if entry["day"] not in selected_days] + list(replacements.values()),
            key=lambda entry: entry["day"],
        )
        destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{course}: " + ", ".join(f"Day {day}=20" for day in sorted(selected_days)))


if __name__ == "__main__":
    main()
