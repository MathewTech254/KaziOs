# KaziOS — Competition presentation

`KaziOS-Presentation.pptx` — a 13-slide jury deck for KaziOS, generated with `pptxgenjs` using the project's brand assets and palette.

## Slides

| #   | Slide                        | Content                                                                   |
| --- | ---------------------------- | ------------------------------------------------------------------------- |
| 1   | Cover                        | Logo, tagline, author, repo link                                          |
| 2   | The problem                  | Ten disconnected tools, four consequences                                 |
| 3   | Built for a different market | Mobile money, multi-branch, connectivity, pricing                         |
| 4   | The solution                 | One sale → six connected systems (diagram)                                |
| 5   | The platform                 | Live POS screenshot + 8 modules + cross-cutting capabilities              |
| 6   | Flagship integration         | Paystack + M-PESA dual-rail billing + live billing portal screenshot      |
| 7   | Business model               | Freemium SaaS, server-side entitlements                                   |
| 8   | Market & users               | Kenya-first, four personas, why now                                       |
| 9   | Where we are                 | Live today vs in active build + live dashboard screenshot (honest status) |
| 10  | Technology                   | Web / API / data & infra + quality & security                             |
| 11  | Roadmap                      | Now → Next → Later                                                        |
| 12  | Why KaziOS                   | Closing argument (4 proofs)                                               |
| 13  | Thank you                    | Contact, repo, demo invitation                                            |

## Notes

- Every slide has **speaker notes** (PowerPoint: View → Notes, or the notes pane below the slide).
- Slides 5, 6 and 9 embed **live product screenshots** captured against the dev stack by `apps/web/scripts/shoot-deck.mjs` (POS with a real cart line, the billing portal with the Card/M-PESA rail toggle, and the dashboard with real org data).
- Design follows the brand: ink `#07152D`, gold `#F5A314`, orange/teal/green from `apps/web/public/logo.png`.
- Fully editable — open in PowerPoint or import into Google Slides, then export to PDF from there.
- Claims match `README.md`: everything under **LIVE TODAY** is shipped (tests, docs, both payment rails); everything under **IN ACTIVE BUILD** is open roadmap work.
