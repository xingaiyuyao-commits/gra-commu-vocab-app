import importlib.util
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_review_pdfs", ROOT / "scripts" / "build-review-pdfs.py"
)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class ReviewPdfBuilderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        BUILDER.register_fonts()
        cls.temp_dir = tempfile.TemporaryDirectory()
        cls.pdf_path = BUILDER.build_pdf("clacel", Path(cls.temp_dir.name))
        cls.pages = [page.extract_text() or "" for page in PdfReader(cls.pdf_path).pages]

    @classmethod
    def tearDownClass(cls):
        cls.temp_dir.cleanup()

    def test_answer_section_has_score_field_out_of_50(self):
        answer_page = next(page for page in self.pages if "答え・復習用一覧" in page)
        self.assertIn("/ 50", answer_page)

    def test_question_blank_is_one_and_a_half_times_longer(self):
        question_text = "\n".join(self.pages[:6])
        self.assertEqual(question_text.count("_______________"), 50)


if __name__ == "__main__":
    unittest.main()
