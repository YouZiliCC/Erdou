---
name: pdf
description: Create PDF documents with fpdf2 (no LaTeX or browser needed)
---

# Making PDF files (.pdf)

Use this when the task is to generate a PDF. `fpdf2` is pure Python — no LaTeX and
no headless browser required — and is pre-bundled in Erdou.

## Setup

    pip install fpdf2

Note: you `pip install fpdf2`, but the import name is `fpdf`.

## Minimal example

```python
from fpdf import FPDF

pdf = FPDF()
pdf.add_page()

pdf.set_font("Helvetica", style="B", size=20)
pdf.cell(0, 12, "Invoice")
pdf.ln(14)

pdf.set_font("Helvetica", size=12)
pdf.cell(0, 8, "Bill to: Acme Corp")
pdf.ln(10)

for item, price in [("Widget", "$10.00"), ("Gadget", "$25.00")]:
    pdf.cell(100, 8, item, border=1)
    pdf.cell(40, 8, price, border=1)
    pdf.ln(8)

pdf.output("/out.pdf")
print("wrote /out.pdf")
```

## Tips

- `cell(w, h, text, border=, align=)` draws one cell; call `pdf.ln(h)` to move to the next line.
- `multi_cell(w, h, long_text)` wraps long text across lines.
- Images: `pdf.image("/pic.png", w=80)`.
- Built-in fonts: Helvetica, Times, Courier. For non-Latin/Unicode text, register a
  TTF first: `pdf.add_font("Noto", "", "/NotoSans-Regular.ttf"); pdf.set_font("Noto")`.
