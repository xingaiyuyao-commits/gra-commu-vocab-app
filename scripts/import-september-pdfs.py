#!/usr/bin/env python3
"""Import the approved September vocabulary PDFs into immutable site JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import defaultdict
from dataclasses import dataclass, replace
from pathlib import Path

import pdfplumber


STUDY_DAYS = (1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25)
EXPECTED_TOTALS = {"clacel": 420, "toeic": 440, "ielts": 440}
LABELS = {"clacel": "Clacel", "toeic": "TOEIC", "ielts": "IELTS"}


@dataclass(frozen=True)
class WordRow:
    base: str
    answer: str
    meaning: str
    example: str
    translation: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip()).lower()


def compact(value: str) -> str:
    return re.sub(r"\s+", "", normalize(value))


def grouped_table_boundaries(page) -> list[float]:
    return sorted({
        round(line["top"], 1)
        for line in page.lines
        if line["x0"] < 60 and line["x1"] > 530 and 100 < line["top"] < 760
    })


def line_has_size(line: dict, size: float) -> bool:
    return bool(line["chars"]) and all(abs(float(char["size"]) - size) < 0.2 for char in line["chars"])


def is_bold_answer_char(char: dict) -> bool:
    normalized_font = re.sub(r"[^a-z]", "", str(char["fontname"]).lower())
    return "dejavusansbold" in normalized_font and abs(float(char["size"]) - 10.0) < 0.2


def parse_word_rows(page) -> list[WordRow]:
    rows: list[WordRow] = []
    boundaries = grouped_table_boundaries(page)
    for top, bottom in zip(boundaries, boundaries[1:]):
        left = page.crop((51, top + 0.2, 165, bottom - 0.2)).extract_text(x_tolerance=1, y_tolerance=2) or ""
        if not re.search(r"N\s*O\s*\.\s*\d", left):
            continue
        left_lines = [line.strip() for line in left.splitlines() if line.strip()]
        try:
            ipa_index = next(index for index, line in enumerate(left_lines) if line.startswith("/"))
        except StopIteration as exc:
            raise ValueError(f"見出し語のIPAを特定できません: {left!r}") from exc
        base = normalize(" ".join(left_lines[1:ipa_index]))
        if not base:
            raise ValueError(f"見出し語を特定できません: {left!r}")

        text_lines = page.crop((165, top + 0.2, 544, bottom - 0.2)).extract_text_lines(return_chars=True)
        meaning = "".join(line["text"] for line in text_lines if line_has_size(line, 11.0)).strip()
        example = " ".join(line["text"] for line in text_lines if line_has_size(line, 10.0)).strip()
        translation = "".join(line["text"] for line in text_lines if line_has_size(line, 9.0)).strip()
        bold_parts = []
        for line in text_lines:
            bold = "".join(
                char["text"]
                for char in line["chars"]
                if is_bold_answer_char(char)
            ).strip()
            if bold:
                bold_parts.append(bold)
        answer = normalize(" ".join(bold_parts))
        if not all((meaning, example, translation, answer)):
            raise ValueError(f"単語行の必須項目が不足しています: base={base!r}, answer={answer!r}")
        rows.append(WordRow(base, answer, meaning, example, translation))
    return rows


def parse_answer_key(text: str) -> list[str]:
    answers = [
        (int(number), normalize(answer))
        for number, answer in re.findall(r"(\d+)\.\s+(.+?)\s+/[^/\n]+/", text)
    ]
    return [answer for _, answer in sorted(answers)]


def parse_pdf(path: Path) -> dict[int, list[WordRow]]:
    rows_by_day: dict[int, list[WordRow]] = defaultdict(list)
    answers_by_day: dict[int, list[str]] = {}
    current_day: int | None = None
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=1, y_tolerance=2) or ""
            match = re.search(r"Day\s+(\d{2})", text)
            if match:
                current_day = int(match.group(1))
            if current_day is None:
                continue
            if "Answer Key" in text:
                answers_by_day[current_day] = parse_answer_key(text)
            elif re.search(r"N\s*O\s*\.\s*\d", text):
                rows_by_day[current_day].extend(parse_word_rows(page))

    if tuple(sorted(rows_by_day)) != STUDY_DAYS:
        raise ValueError(f"Day構成が不正です: {tuple(sorted(rows_by_day))}")
    if tuple(sorted(answers_by_day)) != STUDY_DAYS:
        raise ValueError(f"解答ページのDay構成が不正です: {tuple(sorted(answers_by_day))}")

    ordered: dict[int, list[WordRow]] = {}
    for day in STUDY_DAYS:
        unused = list(rows_by_day[day])
        selected: list[WordRow] = []
        for answer in answers_by_day[day]:
            candidates = [row for row in unused if compact(row.answer) == compact(answer)]
            if len(candidates) != 1:
                raise ValueError(
                    f"Day {day} の解答 {answer!r} に対応する単語行が一意ではありません: "
                    f"{[(row.base, row.answer) for row in candidates]}"
                )
            row = candidates[0]
            selected.append(replace(row, answer=answer))
            unused.remove(row)
        if unused or len(selected) != len(rows_by_day[day]):
            raise ValueError(f"Day {day} に未対応の単語行があります: {[(row.base, row.answer) for row in unused]}")
        ordered[day] = selected
    return ordered


def replace_answer(example: str, answer: str) -> str:
    pattern = re.compile(rf"(?<![a-z]){re.escape(answer)}(?![a-z])", re.IGNORECASE)
    sentence, count = pattern.subn("___", example, count=1)
    if count != 1:
        raise ValueError(f"例文から正答を空欄化できません: answer={answer!r}, example={example!r}")
    return sentence


def standalone_pattern(value: str) -> re.Pattern[str]:
    return re.compile(rf"(^|[^a-z]){re.escape(value.lower())}([^a-z]|$)")


def remove_answer_notes(meaning: str, answer: str) -> str:
    escaped = re.escape(answer)
    without_half_width = re.sub(rf"\([^)]*(?<![a-z]){escaped}(?![a-z])[^)]*\)\s*", "", meaning, flags=re.IGNORECASE)
    without_full_width = re.sub(rf"（[^）]*(?<![a-z]){escaped}(?![a-z])[^）]*）\s*", "", without_half_width, flags=re.IGNORECASE)
    return without_full_width.strip()


def build_dataset(course: str, source: Path, rows_by_day: dict[int, list[WordRow]]) -> dict:
    source_hash = sha256(source)
    revision = f"2026-09-04-{source_hash[:12]}"
    series = []
    for day in STUDY_DAYS:
        items = []
        for index, row in enumerate(rows_by_day[day], 1):
            question_id = f"2026-09/{course}/day{day:02d}/q{index:02d}"
            meaning = remove_answer_notes(row.meaning, row.answer)
            if course == "clacel" and row.base == "leave":
                meaning = "OをCのままにしておく、置き忘れる、去る"
            item = {
                "questionId": question_id,
                "sentence": replace_answer(row.example, row.answer),
                "answer": row.answer,
                "base": row.base,
                "hint": row.base[0] + "_" * (len(row.base) - 1),
                "ja": meaning,
                "sentenceJa": row.translation,
            }
            clue = f"{item['sentence'].replace('___', '')} {item['ja']}".lower()
            if any(standalone_pattern(value).search(clue) for value in (item["answer"], item["base"])):
                raise ValueError(f"正答が問題文またはヒントへ露出しています: {question_id}")
            items.append(item)
        series.append({"name": f"Day {day}", "day": day, "items": items})
    if sum(len(day["items"]) for day in series) != EXPECTED_TOTALS[course]:
        raise ValueError(f"{course}の問題数が不正です")
    return {"label": LABELS[course], "datasetRevision": revision, "series": series}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clacel", required=True, type=Path)
    parser.add_argument("--toeic", required=True, type=Path)
    parser.add_argument("--ielts", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "wordtests")
    args = parser.parse_args()
    sources = {course: getattr(args, course).resolve() for course in ("clacel", "toeic", "ielts")}
    for source in sources.values():
        if not source.is_file():
            raise FileNotFoundError(source)

    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"generatedAt": "2026-09-04", "courses": {}}
    for course, source in sources.items():
        dataset = build_dataset(course, source, parse_pdf(source))
        destination = args.output / f"{course}-2026-09.json"
        destination.write_text(json.dumps(dataset, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest["courses"][course] = {
            "sourcePdf": source.name,
            "sha256": sha256(source),
            "datasetRevision": dataset["datasetRevision"],
            "questions": sum(len(day["items"]) for day in dataset["series"]),
        }
        print(f"{course}={manifest['courses'][course]['questions']}", flush=True)
    (args.output / "manifest-2026-09.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("answer_leaks=0", flush=True)


if __name__ == "__main__":
    main()
