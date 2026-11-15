# Page builder misses

Misses caught by eye while building a visual page builder, one row per miss.
Each row names the general rule the miss suggests and, where we knew it, how
a check could catch it and the state that shows it.

| Week | Misses |
| --- | --- |
| 1 | 9 |
| 2 | 13 |

```md
| ID | Observation | General rule |
| --- | --- | --- |
| X-1 | Inside a fence, never imported | Fenced tables are examples |
```

| ID | Observation | General rule | Category | How it could be checked | State that would show it |
| --- | --- | --- | --- | --- | --- |
| M-01 | The canvas text on the dark toolbar is barely legible | Text meets 4.5:1 contrast against its background | Color | `contrast` | editor |
| M-02 | Resize handles are tiny | The resize handles should be 8px | Size | component-size measurement | editor |
| M-03 | The publish button says Go live | Say "Publish", not "Go live" | Copy | glossary | publish-dialog |
| M-04 | The close icon in the settings panel has a 16px hit area | Interactive targets are at least 24px | Touch | target-size | studio-lab/settings |
| M-05 | Layer list rows jump sideways when hovered | Hover never shifts layout | Motion | by eye | |
| M-06 | The settings panel scroll clips the last field | Panels never clip their content | Layout | overflow-clip | |
| M-07 | The undo toast overlaps the publish dialog footer | Toasts never cover dialog actions | Layout | element-overlap | |
| M-08 | Template cards have uneven gaps | Card grids keep one gap | Spacing | spacing-rhythm | template gallery |
| M-09 | Colour picker swatches look different from the Figma mock | Swatches match the design reference | Visual | compare to the mock | |
| M-10 | Alignment guides flicker during drag | Guides appear steadily while dragging | Motion | `motion` | |
| M-11 | Placeholder text is faint in the settings form | Placeholder text stays readable | Color | the contrast ratio, by eye | settings |
| M-12 | The breakpoint menu label is cut off | Labels never truncate mid-word | Text | clipped-text | editor |
| M-13 | The page title field and the slug field are different widths | The title field and the slug field should mirror each other | Layout | | settings |
| M-14 | The "Grid \| Free" toggle reads as one label | Toggle labels name each option | Copy | judged | editor |
| M-15 | The asset upload dialog has no empty state | Every list has an empty state | States | missing-state | asset library |
| M-16 | The publish dialog primary action is grey at rest | One primary action per dialog | Hierarchy | idiom:primary-region | publish-dialog |
| M-17 | Text in the font menu is not vertically centred | Text sits centred in its control | Type | text-centering | editor |
| M-18 | Section padding differs between blocks<br>on the canvas | Section padding follows the spacing scale | Spacing | scale-conformance | editor |
|  | An unnamed miss in the inspector | Inspector rows align | Layout | | editor |
| M-19 | The navigator collapses unexpectedly |  | Behaviour | | |
| M-03 | Another copy miss | Use one word for one action | Copy | | |
| M-20 | Too | many | cells | in | this | row | here |
|  |  |  |  |  |  |
| M-21 | The history panel has no name for screen readers | Every control has an accessible name | A11y | a11y-label | |
| M-23 | The publish dialog close button has no label | Every control has an accessible name | A11y | a11y-label | publish-dialog |

Rows are added as they are found.
