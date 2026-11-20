# Show the offset on the selection toolbar

## What and why

A selection toolbar gains a chip that shows the selection's offset, so people can read the position without opening the inspector.

## Acceptance criteria

- The chip adds at most 64px to the toolbar, keeps ≥4px between items glyph to glyph, and never overlaps the reset button.
- The toolbar stays on one row at 1024px.
- The chip label is no longer than 12 characters and never truncates.
- The chip fade-in lasts no more than 150ms and ends fully visible.

## Out of scope

- Editing the offset from the chip.
