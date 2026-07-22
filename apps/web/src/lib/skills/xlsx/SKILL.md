---
name: xlsx
description: Create or edit Excel (.xlsx) workbooks with openpyxl
---

# Making Excel files (.xlsx)

Use this when the task is to generate or edit a spreadsheet. `openpyxl` is pure
Python (no native dependency) and pre-bundled, so it installs from a local wheel
with no PyPI round-trip.

## Setup

    pip install openpyxl

## Minimal example

```python
from openpyxl import Workbook
from openpyxl.styles import Font

wb = Workbook()
ws = wb.active
ws.title = "Sales"

ws.append(["Month", "Revenue"])
ws["A1"].font = Font(bold=True)
ws["B1"].font = Font(bold=True)
for month, rev in [("Jan", 1000), ("Feb", 1200), ("Mar", 900)]:
    ws.append([month, rev])
ws["B5"] = "=SUM(B2:B4)"
ws.column_dimensions["A"].width = 12

wb.save("/out.xlsx")
print("wrote /out.xlsx")
```

## Tips

- Cells: `ws["A1"] = value` or `ws.cell(row=1, column=1, value=...)`; `ws.append([...])` adds a row.
- Formulas are just strings that start with `=`.
- Multiple sheets: `ws2 = wb.create_sheet("Costs")`.
- To EDIT: `from openpyxl import load_workbook; wb = load_workbook("/existing.xlsx")`.
- Charts: `from openpyxl.chart import BarChart, Reference`.
