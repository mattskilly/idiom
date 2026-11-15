# Director's catches: a visual page builder

Every miss the director caught by eye while the page builder was built, one
row per catch, with the general rule it suggests in checkable form.

† the catch was found again after it had been marked fixed.

## Rulings

| id | ruling | date |
| --- | --- | --- |
| R-1 | Toolbars stay one row at every width | 2026-10-02 |
| R-2 | The canvas never scrolls sideways | 2026-10-09 |

## New states

| state | description |
| --- | --- |
| inline-editor | A text block with the inline editor open |
| empty-canvas | A fresh page with nothing on the canvas |

## Catalog

| id | date | surface | what was wrong | general rule (checkable law) | category | how | idiom state | source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PB-001 | 2026-09-14 | Editor toolbar | Grey icon labels on the dark toolbar are hard to read | Text meets 4.5:1 contrast against its background | Color | `contrast` | editor | director |
| PB-002 | 2026-09-14 | Editor toolbar | The undo and redo buttons are tiny tap targets | Every control is at least 24px in both directions | Sizing | target-size | editor | director |
| PB-003 | 2026-09-15 | Layers panel | Layer names are cut off with no ellipsis | Text that can overflow truncates with an ellipsis | Overflow | overflow-clip | editor | director |
| PB-004† | 2026-09-16 | Settings | The save button sits flush against the field above it | Controls keep at least 8px between them | Spacing | by eye | settings | director |
| PB-005 | 2026-09-16 | Settings | Section headings use three different weights | Headings at one level share one weight | Type | by eye | studio-lab/settings | agent review |
| PB-006 | 2026-09-17 | Publish dialog | The primary button is not the rightmost action | The primary action is last in a dialog's button row | Layout | by eye | publish-dialog | director |
| PB-007 | 2026-09-18 | Inline editor | The inline editor's toolbar covers the text being edited | A floating toolbar never covers its own selection | Layout | by eye | NEW: A text block with the inline editor open | director |
| PB-008 | 2026-09-18 | Canvas | An empty page shows a blank white canvas with no hint | An empty canvas says what to do first | Empty state | by eye | NEW: empty canvas | director |
| PB-009 | 2026-09-19 | Publish dialog | The error banner pushes the publish button off screen | A dialog's actions stay visible when it shows an error | Layout | by eye | NEW: publish dialog with a failed publish error | director |
| PB-010† | 2026-09-20 | Editor toolbar | The selected tool shows a doubled ring †again | A selected control draws one selection ring | Selection | by eye | editor | director |
| PB-011 | 2026-09-21 | Settings | Toggle labels are not vertically centred on the switch | A label is centred on the control it names | Alignment | by eye | settings | director |
| PB-012 | 2026-09-22 | Canvas | Resizing a block collapses its padding |  | Spacing | by eye | editor | director |
| PB-013 | 2026-09-22 | Canvas | Section padding differs between adjacent blocks | Adjacent sections share one padding | Spacing | by eye | editor | director |
| PB-014† | 2026-09-23 | Layers panel | Dragged layers lose their indent level † | A nested item keeps its indent while dragged | Layout | by eye |  | director |
| PB-015 | 2026-09-24 | Publish dialog | The domain field label says "URL" and the help says "address" | Say "domain", not "URL" | Copy | copy-lint | publish-dialog | agent review |
| PB-016 | 2026-09-25 | Settings | Help text sits closer to the next field than to its own | Help text sits closer to its own field than the next | Spacing | by eye | settings | director |
| PB-013 | 2026-09-26 | Canvas | Padding drifts again after undo | Adjacent sections share one padding | Spacing | by eye | editor | director |
| PB-017 | 2026-09-27 | Editor toolbar | The zoom percentage jitters as digits change | Changing numbers use tabular figures | Type | by eye | editor | director |
| PB-018 | 2026-09-28 | Inline editor | The link popover opens off the right edge | A popover stays inside the viewport | Overflow | by eye | NEW: link popover open near the right edge | director |
| PB-019 | 2026-09-29 | Settings | The danger zone uses the same blue as safe actions | A destructive action is styled as destructive | Color | by eye | settings | director |
| PB-020 | 2026-09-30 | Publish dialog | The close button is smaller than the other dialog controls | Every control is at least 24px in both directions | Sizing | `target-size` | publish-dialog | director |
