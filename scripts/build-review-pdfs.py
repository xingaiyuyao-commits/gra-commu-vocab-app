#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
COURSES = {
    "clacel": ("Clacel", "clacel-2026-09.json"),
    "toeic": ("TOEIC", "toeic-2026-09.json"),
    "ielts": ("IELTS", "ielts-2026-09.json"),
}
GOLD = colors.HexColor("#C99517")
INK = colors.HexColor("#202020")
GRAY = colors.HexColor("#666666")
LIGHT = colors.HexColor("#F6F5F2")
LINE = colors.HexColor("#D9D7D2")


def register_fonts():
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))


def page_footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
    canvas.setFillColor(GRAY)
    canvas.setFont("HeiseiKakuGo-W5", 7.5)
    canvas.drawString(18 * mm, 8.5 * mm, "ÖSH Vocabulary Challenge")
    canvas.drawRightString(A4[0] - 18 * mm, 8.5 * mm, str(doc.page))
    canvas.restoreState()


def styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("title", parent=base["Title"], fontName="HeiseiKakuGo-W5", fontSize=21, leading=27, textColor=INK, alignment=TA_CENTER, spaceAfter=4 * mm),
        "subtitle": ParagraphStyle("subtitle", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=9.5, leading=15, textColor=GRAY, alignment=TA_CENTER, spaceAfter=8 * mm),
        "section": ParagraphStyle("section", parent=base["Heading2"], fontName="HeiseiKakuGo-W5", fontSize=16, leading=22, textColor=INK, spaceAfter=5 * mm),
        "qno": ParagraphStyle("qno", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=8, leading=10, textColor=GOLD, spaceAfter=1.5 * mm),
        "meaning": ParagraphStyle("meaning", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=10, leading=14, textColor=INK, spaceAfter=1 * mm),
        "hint": ParagraphStyle("hint", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=9, leading=12, textColor=GRAY, spaceAfter=1 * mm),
        "sentence": ParagraphStyle("sentence", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=10, leading=14, textColor=INK, spaceAfter=1 * mm),
        "sentence_ja": ParagraphStyle("sentence_ja", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=8.5, leading=12, textColor=GRAY, spaceAfter=2 * mm),
        "answer": ParagraphStyle("answer", parent=base["Normal"], fontName="HeiseiKakuGo-W5", fontSize=8.5, leading=12, textColor=INK),
    }


def load_questions(category):
    fixed = json.loads((ROOT / "data/wordtests/review-2026-09.json").read_text())
    label, filename = COURSES[category]
    course = json.loads((ROOT / "data/wordtests" / filename).read_text())
    ids = fixed["days"]["7"]["courses"][category]["questionIds"]
    by_id = {item["questionId"]: item for series in course["series"] for item in series["items"]}
    questions = [by_id[question_id] for question_id in ids]
    if len(questions) != 50 or len(set(ids)) != 50:
        raise ValueError(f"{label}: fixed review set must contain 50 unique questions")
    return label, questions


def build_pdf(category, output_dir):
    label, questions = load_questions(category)
    style = styles()
    output = output_dir / f"{label}_2026-09-12_Day7_復習問題_50問.pdf"
    doc = BaseDocTemplate(str(output), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=17 * mm, bottomMargin=18 * mm, title=f"{label} 9月12日 Day 7 復習問題", author="ÖSH Vocabulary Challenge")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="content")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=page_footer)])

    story = [
        Paragraph("ÖSH Vocabulary Challenge", style["title"]),
        Paragraph(f"{label}　9月12日（Day 7）復習問題　全50問", style["subtitle"]),
        Paragraph("問題", style["section"]),
    ]
    for index, question in enumerate(questions, 1):
        answer_line = Table([[""]], colWidths=[doc.width - 10 * mm], rowHeights=[6 * mm])
        answer_line.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.7, GRAY)]))
        content = [
            Paragraph(f"QUESTION {index:02d}", style["qno"]),
            Paragraph(escape(question.get("ja", "")), style["meaning"]),
            Paragraph(escape(question.get("hint", "")), style["hint"]),
            Paragraph(escape(question.get("sentence", "")).replace("___", "__________"), style["sentence"]),
            Paragraph(escape(question.get("sentenceJa", "")), style["sentence_ja"]),
            answer_line,
        ]
        card = Table([[content]], colWidths=[doc.width], style=TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), LIGHT),
            ("BOX", (0, 0), (-1, -1), 0.5, LINE),
            ("LEFTPADDING", (0, 0), (-1, -1), 5 * mm),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
            ("TOPPADDING", (0, 0), (-1, -1), 3 * mm),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3 * mm),
        ]))
        story.extend([card, Spacer(1, 3 * mm)])

    story.extend([PageBreak(), Paragraph("答え・復習用一覧", style["section"]), Paragraph("問題を解き終えてから確認してください。", style["subtitle"])])
    for start in range(0, 50, 10):
        rows = []
        for index, question in enumerate(questions[start:start + 10], start + 1):
            answers = " / ".join([question["answer"], *question.get("altAnswers", [])])
            completed = question.get("sentence", "").replace("___", f"<b>{escape(answers)}</b>")
            rows.append([
                Paragraph(f"<b>{index}.</b>", style["answer"]),
                Paragraph(f"<b>{escape(answers)}</b><br/>{escape(question.get('ja', ''))}<br/>{completed}<br/><font color='#666666'>{escape(question.get('sentenceJa', ''))}</font>", style["answer"]),
            ])
        table = Table(rows, colWidths=[10 * mm, doc.width - 10 * mm], repeatRows=0)
        table.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.4, LINE),
            ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
            ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ]))
        story.extend([table, Spacer(1, 3 * mm)])

    doc.build(story)
    return output


def main():
    register_fonts()
    output_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "output" / "pdf"
    output_dir.mkdir(parents=True, exist_ok=True)
    for category in COURSES:
        print(build_pdf(category, output_dir))


if __name__ == "__main__":
    main()
