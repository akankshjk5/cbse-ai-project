# KTBS permission request — DRAFT FOR REVIEW, NOT SENT

**Status: not sent. Do not send without the review below being completed by a
person.** Every `[SQUARE BRACKET]` is a placeholder for a fact this document
does not have. None of them are guesses, and a letter sent with any of them
still in it would be making a claim nobody checked.

Why this letter exists: Lumina currently generates **original** educational
content (`content_mode = 'original_generated'`). It does not reproduce textbook
text, photographs or diagrams, and the rights schema refuses to publish a lesson
whose sources are unresolved. This letter is what would be needed *before* that
changes — before any KTBS material is ingested, displayed, adapted or
redistributed.

Nothing in the product depends on a reply. If permission is refused or never
arrives, Lumina keeps doing what it does today.

---

## Before sending — the review checklist

| # | Check | Who | Done |
|---|---|---|---|
| 1 | Confirm the correct addressee, designation and postal address from the official KTBS website or by telephone. Do not copy them from a search result. | | ☐ |
| 2 | Confirm whether KTBS or the Department of School Education and Literacy is the correct rights holder for the specific titles named. | | ☐ |
| 3 | Fill every `[PLACEHOLDER]`. | | ☐ |
| 4 | Legal review of the scope paragraph, which is the operative one. | | ☐ |
| 5 | Decide whether to request commercial redistribution now or only evaluation use. Asking for more than is needed invites a slower answer or a refusal. | | ☐ |
| 6 | Confirm the entity name and registration under which this is sent. | | ☐ |
| 7 | Send by a route that produces an acknowledgement. Record the date, reference number and recipient in `lesson_sources`. | | ☐ |

**Do not** interpret silence as consent, and do not record a `source_rights_status`
of anything other than `unresolved` until a written reply exists.

---

## Draft letter

> [ENTITY LETTERHEAD]
>
> Date: [DATE]
>
> To
> [NAME], [DESIGNATION]
> Karnataka Textbook Society (R.)
> [FULL POSTAL ADDRESS — verify from the official site]
>
> **Subject: Request for permission to use KTBS textbook content in a
> non-commercial educational pilot**
>
> Respected Sir/Madam,
>
> I am writing on behalf of [ENTITY NAME], [ONE LINE: what the entity is and its
> registration status], regarding an educational tool we are developing for
> government and aided schools in Karnataka.
>
> **What the tool does.** It produces short explanatory videos and editable
> presentation files for classroom use, in Kannada, Hindi and Indian English.
> The teaching material it generates today is written by the system itself and
> is not copied from any textbook. Teachers tell it the class, subject and
> topic, and it produces a lesson they can edit before use.
>
> **What we are asking for.** We would like permission to use the Karnataka
> State syllabus textbooks for Classes [RANGE], specifically [TITLES], for the
> following purposes:
>
> 1. To read the prescribed syllabus and chapter structure, so that generated
>    lessons follow the order and scope a Karnataka classroom actually teaches.
> 2. To allow a small number of teachers — we propose four — to compare
>    generated lessons against the prescribed text during an evaluation, so they
>    can tell us where the generated material is wrong or misleading.
>
> **What we are not asking for, and will not do without a separate written
> permission.** We will not reproduce, display, distribute or adapt textbook
> text, photographs, diagrams or illustrations inside the product or in any
> material shown to students or the public. We will not represent generated
> content as approved by, verified by or originating from KTBS or the Department
> of School Education and Literacy. We will not use the KTBS name or emblem in
> any promotional material.
>
> **Scope and duration.** [NON-COMMERCIAL EVALUATION ONLY / OTHER — decide at
> checklist item 5], for [DURATION], within Karnataka, by [NUMBER] named
> teachers at [SCHOOL NAMES OR "schools to be named on request"].
>
> **Attribution and withdrawal.** We will carry any attribution wording you
> specify. If permission is withdrawn, we will stop the relevant use and confirm
> in writing within [NUMBER] working days; the system records the rights status
> of every source and refuses to publish material whose permission has lapsed.
>
> **Accountability.** We are happy to share the generated lessons, the
> evaluation findings and a technical description of how content is produced, at
> whatever level of detail is useful to you.
>
> We would be grateful for your guidance on the correct process, including any
> fee, undertaking or format you require. I can be reached at [EMAIL] and
> [PHONE].
>
> Yours faithfully,
>
> [NAME]
> [DESIGNATION], [ENTITY NAME]
> [ADDRESS] · [EMAIL] · [PHONE]
>
> Enclosures: [1. One-page description of the tool. 2. Two sample generated
> lessons. 3. [OTHER]]

---

## After a reply arrives

Record it in the database rather than in a folder, because the database is what
refuses to publish:

| Reply | `source_rights_status` | `distribution_scope` |
|---|---|---|
| Written permission, evaluation only | `licensed` | `private_review` or `single_school` as the letter says |
| Written permission, wider use | `licensed` | the narrowest scope the letter actually grants |
| Refusal | `refused` | none — publication stays blocked |
| No reply | **stays `unresolved`** | none |

Keep the signed reply, note its reference number, and record who at KTBS
granted it. "Someone said it was fine" is not evidence, and
`lesson_rights_verdict()` is deliberately unable to act on it.

## What is true today, for the avoidance of doubt

- No textbook **content** — text, photographs, diagrams — has been downloaded,
  stored or reproduced anywhere in the system.
- `scripts/ingest-ktbs-catalogue.mts` does fetch one public page,
  `textbooks.karnataka.gov.in/textbooks/en`, and parses it into a list of
  titles and their published URLs (`data/ktbs-catalogue.json`). That is
  catalogue metadata, and the script does not follow those URLs or download a
  textbook. Said plainly here rather than omitted, because "we scraped nothing"
  would be the kind of small inaccuracy that makes the rest of a letter
  unreliable.
- Public download availability does not grant redistribution rights, and nothing
  in this repository treats it as though it does.
