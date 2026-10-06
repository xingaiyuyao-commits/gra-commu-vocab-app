# PDF learner browser acceptance

Run on a machine with Node 24 and real Chrome/Chromium:

```sh
npm ci
PDF_BROWSER_ARTIFACT_DIR=validation/pdf-browser node --test tests/pdf-learner-browser.test.js
```

`CHROME_BIN` can identify an existing Chrome executable. The test fails if Chrome
cannot start; it never skips browser acceptance or substitutes jsdom. The first
test validates the independent oracle without launching Chrome:

```sh
node --test --test-name-pattern='PDF oracle' tests/pdf-learner-browser.test.js
```

## Source independence

`pdf-days29-34-2026-10.json` was extracted from the three latest Drive PDFs freshly
checked on 2026-10-06. Its `sources` entries retain exact filenames, Drive file IDs,
modification timestamps, PDF SHA-256 values, and page counts. The downloaded
bytes also matched the user's supplied PDFs.

Every expected answer comes from a PDF answer key. Each practice sentence plus
that answer was matched exactly to the PDF vocabulary-list example before the
fixture was created. `number` is the vocabulary-list number used in `questionId`;
`practice_number` is the separately shuffled PDF practice/answer-key number.
One-based `source_page`, `practice_page`, and `answer_page` identify the evidence.
Do not regenerate this fixture from application question data or change an
expected answer simply to match a failing application.

The only display normalization is IELTS Day 34 list question 12: the PDF meaning
has an `on the threshold of：` label, which the application omits. The fixture
preserves the PDF text and the test documents this exception explicitly.

## Coverage and isolation

- Real learner page and live local Socket.IO connection, no socket/UI mocks.
- 18 course/day rounds, all 360 questions, each independently matched by its
  displayed sentence to the PDF oracle despite the application's random order.
- Physical CDP pointer clicks and trusted browser text input into each answer
  field; ordinary confirmation and submit buttons drive the application.
- Meaning, translation, first-letter hint, full reconstructed sentence, 20/20
  server-issued score, result lists, and retained answers checked against PDFs.
- Submitted waiting-screen reload and result reload for each course's Day 29.
- Additional Clacel Day 33 round enters `depend` for Q16, requires 19/20, checks
  the exact `depend on` review sentence without duplicated `on`, then retries
  successfully with the PDF answer and reloads the original official result.
- Host setup/start/reveal uses an authenticated test Socket.IO client. This is a
  learner acceptance test, not a host UI test.

The server uses a random local port, temporary persistence, a random test-only
operator password, and cleared scheduled-link/production environment settings.
There is no remote URL override and no production room is contacted or altered.
All browser data is synthetic. An optional artifact directory receives a JSON
report, successful `depend on` review/retry screenshots, and, on browser-stage
failure, a screenshot and visible-page snapshot.

Passing the oracle-only check is not a browser pass. In restricted executors,
Chrome may fail with `socket() failed: Operation not permitted`; run the full
test in hosted CI and inspect its actual result before release acceptance.
