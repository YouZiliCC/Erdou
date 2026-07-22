---
name: docx
description: Create or edit Word (.docx) documents with python-docx
---

# Making Word files (.docx)

Use this when the task is to generate or edit a Word document.

## Setup

`python-docx` is pre-bundled in Erdou (installs offline on the browser kernel):

    pip install python-docx

Note: you `pip install python-docx`, but the import package is `docx`.

## Minimal example

```python
from docx import Document
from docx.shared import Pt

doc = Document()
doc.add_heading("Project Report", level=0)
doc.add_paragraph("Prepared for the Q3 review.")

doc.add_heading("Summary", level=1)
p = doc.add_paragraph("Revenue was ")
p.add_run("up 12%").bold = True

doc.add_paragraph("First item", style="List Bullet")
doc.add_paragraph("Second item", style="List Bullet")

table = doc.add_table(rows=1, cols=2)
table.style = "Light Grid Accent 1"
hdr = table.rows[0].cells
hdr[0].text, hdr[1].text = "Metric", "Value"
row = table.add_row().cells
row[0].text, row[1].text = "Revenue", "$1.2M"

doc.save("/out.docx")
print("wrote /out.docx")
```

## Tips

- Headings: `add_heading(text, level=0..9)` (0 = title). Body: `add_paragraph`.
- Inline formatting is per-run: `run = para.add_run("bold"); run.bold = True`.
- Images: `doc.add_picture("/img.png", width=Inches(4))` (import `Inches` from `docx.shared`).
- To EDIT an existing document: `Document("/existing.docx")`.
