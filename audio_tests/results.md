# RQ1/RQ2 results

Test set: `audio_tests/scripts/rq1_utterances.md`. Fill in after recording +
transcribing — see that file's "After recording" section for the steps.

## RQ1 — baseline (no keyterms)

| id | bucket | ground truth | hypothesis | WER |
|---|---|---|---|---|
| a01 | A |  |  |  |
| a02 | A |  |  |  |
| a03 | A |  |  |  |
| a04 | A |  |  |  |
| a05 | A |  |  |  |
| a06 | A |  |  |  |
| a07 | A |  |  |  |
| a08 | A |  |  |  |
| a09 | A |  |  |  |
| a10 | A |  |  |  |
| b01 | B |  |  |  |
| b02 | B |  |  |  |
| b03 | B |  |  |  |
| b04 | B |  |  |  |
| b05 | B |  |  |  |
| b06 | B |  |  |  |
| b07 | B |  |  |  |
| b08 | B |  |  |  |
| b09 | B |  |  |  |
| b10 | B |  |  |  |
| c01 | C |  |  |  |
| c02 | C |  |  |  |
| c03 | C |  |  |  |
| c04 | C |  |  |  |
| c05 | C |  |  |  |
| c06 | C |  |  |  |
| c07 | C |  |  |  |
| c08 | C |  |  |  |
| c09 | C |  |  |  |
| c10 | C |  |  |  |

**Per-bucket average WER:** A = &nbsp;&nbsp;&nbsp; B = &nbsp;&nbsp;&nbsp; C = &nbsp;&nbsp;&nbsp;

**Verdict (per PLAN.md's Day 1-3 gate):** if bucket B's WER is unusable,
pivot the language angle now — see PLAN.md Section 8 risks / Section 9
cut list.

## RQ2 — with `keyterms_prompt` (agent.py's `KEYTERMS` list)

Same table shape, rerun on the same recordings with keyterms supplied.
Look at a01/a03/a07/b01/b02/b03/b09/c02/c04/c09 first — they're the
utterances built around the exact keyterms being tested.

| id | bucket | ground truth | hypothesis | WER | Δ vs RQ1 |
|---|---|---|---|---|---|
| a01 | A |  |  |  |  |
| a03 | A |  |  |  |  |
| a07 | A |  |  |  |  |
| b01 | B |  |  |  |  |
| b02 | B |  |  |  |  |
| b03 | B |  |  |  |  |
| b09 | B |  |  |  |  |
| c02 | C |  |  |  |  |
| c04 | C |  |  |  |  |
| c09 | C |  |  |  |  |

**Per-bucket average WER delta:** A = &nbsp;&nbsp;&nbsp; B = &nbsp;&nbsp;&nbsp; C = &nbsp;&nbsp;&nbsp;

A before/after bar chart of this table is the most credible thing to put
in the hackathon submission per PLAN.md Section 6.
