# SAP PI/PO TUT Generator

Builds a **change-specific Technical Unit Testing (TUT)** Word document (.docx, Positive or Negative) from an uploaded SAP PI/PO Technical Specification Document (TSD, `.docx` or `.pdf`).

* The **latest Revision History entry** decides *what* is tested.
* The rest of the TSD (interface sections, receiver determination, mapping tables, embedded Excel/Word mapping objects, Unit Test Plan) supplies *how* and *where*.
* Fully **offline and rule-based**: no LLM, no external calls. The TSD never leaves your machine.

## Run

Run these from the `sap-tut-generator` folder (the one containing `package.json`):

```powershell
npm.cmd install
npm.cmd start        # http://127.0.0.1:3000  (bound to 127.0.0.1 only; set PORT to change)
npm.cmd test         # parser, end-to-end and security tests
```

Or double-click `start.bat`. It installs dependencies on first run, starts the server and opens the browser.

Requires Node.js 20 or later.

## Workflow

1. **Upload** the TSD (up to 80 MB).
2. **Latest revision.** Chosen by revision number, date and order, not by row position. Mixed `dd/mm` and `mm/dd` dates, duplicate numbers and typo dates are handled. If the history is missing, conflicting or unclear, you are asked to pick the entry or enter the change manually. Nothing is guessed.
3. **Change Summary.** Shows the interface, systems, type, revision, CRF/XREF/ADO/JIRA, the verbatim change description, affected components, fields and the application's understanding. You can correct it or confirm it. The description is never edited.
4. **TUT type and optional information.** Positive or Negative. Environment, scenario, expected behaviour, sample payload and assumptions are all optional.
5. **Validation and preview.** Ten checks run, each with a result (pass, review or fail) and the evidence behind it. They cover latest-revision selection, the exact change, TSD consistency, source/target fields, relevance to the TUT type, justified expected results, unsupported assumptions, required steps, document formatting and traceability. Check 9 is measured on the generated `.docx` itself. An overall verdict, the open "needs confirmation" items and every test case are shown. A failed check blocks approval; the `.docx` can only be downloaded after you approve the preview.

## How test cases are produced

| Change recognised in the TSD | Positive TUT | Negative TUT |
|---|---|---|
| Receiver determination / routing condition | Inputs that are routed to the receiver, plus inputs whose behaviour the TSD states | Inputs that must not be routed. Reported as a routing outcome, not an error |
| New receiver | Delivery to the new receiver | Receiver failure test from the TSD Unit Test Plan, if present |
| Optional field / new field / segment / structure / mapping logic | Valid value (and the missing-value case for optional fields), with mapping text quoted from the TSD | Missing or invalid value. The expected result comes from the TSD or is flagged |
| Anything else | Scenarios from the TSD Unit Test Plan | Same |

Every expected result carries a **basis tag**: *Stated in TSD*, *Derived from TSD condition*, *Tester input (not in TSD)* or *Needs confirmation*. Anything the TSD does not establish, or that contradicts itself, is flagged. For example, if a documented routing condition contradicts the TSD narrative, the app reports a **conflict** and asks you to confirm which is right. It never invents mapping logic, field values or error messages.

## Word output

Title block, Interface Details, Change Reference, Objective, Scope, Test Scenario, Preconditions, Test Data, one test case per page (steps table, expected results, blank Actual Results, Status, per-step evidence boxes, Remarks), Status Summary, plus appendices for confirmation items and the quality check. It has headers, footers with page numbers, rows that don't split across pages, and consistent fonts. It is a normal editable `.docx`.

## When the TSD has no change markers

Some TSDs (for example I007071) have no "Start of / End of" markers for the latest revision. The Change Summary then shows a warning and an extra box, "What changed, in your words?". The text you enter becomes the labelled, tester-provided basis for the test case. Its expected result is tagged *Tester input (not in TSD)*. Without it, no test case is invented.

## Known limits

* Mapping detail that exists only as a picture or binary OLE object can't be read. The app says so and flags it.
* PDF input has no table structure, so field and mapping extraction is weaker, and the preview says so.
* Field-name detection is heuristic. Use the *Field / segment name(s)* box in the Change Summary step to correct it.

## Security

Binds to `127.0.0.1` only. Host/Origin checks and a strict CSP are set. Uploads are limited by size and checked by extension and magic bytes. Zip-bomb and XML-entity guards apply. Sessions are held in memory with a TTL. Errors returned to the client are generic, and logs are structured and never contain document content. `npm audit` reports 0 vulnerabilities.
