---
name: pptx
description: Create or edit PowerPoint (.pptx) decks with python-pptx
---

# Making PowerPoint files (.pptx)

Use this when the task is to generate or edit a PowerPoint presentation.

## Setup

`python-pptx` is pre-bundled in Erdou, so this installs offline and fast on the
browser kernel:

    pip install python-pptx

## Minimal example

Write a script and run it with `python`:

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()

title = prs.slides.add_slide(prs.slide_layouts[0])   # title slide
title.shapes.title.text = "Quarterly Review"
title.placeholders[1].text = "Q3 2026"

body = prs.slides.add_slide(prs.slide_layouts[1])     # title + content
body.shapes.title.text = "Highlights"
tf = body.placeholders[1].text_frame
tf.text = "Revenue up 12%"
p = tf.add_paragraph(); p.text = "Two new markets"; p.level = 1

prs.save("/out.pptx")
print("wrote /out.pptx")
```

## Tips

- Slide layouts are `prs.slide_layouts[0..8]` (0 = title, 1 = title+content, 6 = blank).
- Positions/sizes use `Inches(...)` / `Pt(...)` from `pptx.util`.
- Add a text box: `slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))`.
- To EDIT an existing deck, open it: `Presentation("/existing.pptx")`.
- After saving, use `open_preview` or tell the user the file path so they can download it.
