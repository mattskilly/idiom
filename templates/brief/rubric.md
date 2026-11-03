---
version: 1
---

# Design decision rubric

Apply this rubric to a feature request or draft ticket before a ticket is written. Answer **design decision** if any trigger applies to any part of the request. Answer **no design decision** only when every part of the request is a non-trigger.

A bug counts as a non-trigger only when it has one clear right answer. If fixing it means choosing how something looks or behaves, it triggers.

Each open question must name the specific thing to decide in this request, for example "how large is the per-tile pin control, and does it double the tile's height?". Do not repeat the trigger's name as the question.

When a request adds a control, ask how large it is next to what it sits in, and how it behaves with a mouse (on hover), on touch and from the keyboard: a control that appears only on hover does not exist on touch. When a request lets users enter or change something, ask whether they would be typing a raw technical value (a URL, an ID, JSON), and whether the placeholder or default they see looks like the things they can already replace, or like something they cannot.

## Triggers

- `new-control-or-surface`: a new visible control or surface. Example: "add an export button to the toolbar".
- `new-interaction-or-mode`: a new interaction or mode. Example: "let users drag cards between columns".
- `placement-or-timing`: where something lives or when it appears. Example: "show a tip after the first save".
- `input-modality`: hover, touch or keyboard differences. Example: "reveal row actions on hover".
- `density`: density or use of space. Example: "fit more items in the sidebar".
- `concept-naming`: naming a user-facing concept. Example: "call saved filters something users will recognise".
- `per-item-addition`: anything added to every item in a repeated collection. Example: "add a pin button to every tile".
- `raw-technical-input`: a raw technical input (URL, ID, JSON) exposed to end users. Example: "let users set the background image by URL".

## Non-triggers

- `copy-fix`: a typo or wording fix that changes no meaning. Example: "fix the typo in the Publish dialog".
- `single-answer-bug`: a bug with one clear right answer. Example: "the Save button does nothing when the form is valid".
- `tests`: adding or changing tests. Example: "add a test for duplicate form field names".
- `refactor`: changing code without changing what users see. Example: "move the date helpers into one module".
