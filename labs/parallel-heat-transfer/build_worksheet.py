from pathlib import Path
from docx import Document
from docx.text.paragraph import Paragraph
from docx.oxml import OxmlElement

BASE = Path(__file__).resolve().parent
DOCX = BASE / "Parallel_Heat_Transfer_Worksheet.docx"

doc = Document(DOCX)

def norm(text):
    return " ".join((text or "").replace("\u201c", '"').replace("\u201d", '"').replace("\u2013", "-").replace("\u2014", "-").split()).lower()

def find_para(*needles):
    n = [x.lower() for x in needles]
    for p in doc.paragraphs:
        t = norm(p.text)
        if all(x in t for x in n):
            return p
    raise RuntimeError("Paragraph not found: " + " | ".join(needles))

def replace_para(p, text):
    p.text = text

def append_once(p, text, marker):
    if marker.lower() not in norm(p.text):
        p.add_run(text)

def patch_math_operator(p, old="-", new="+"):
    changed = False
    math_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/math}t"
    for node in p._p.iter(math_ns):
        if node.text == old:
            node.text = new
            changed = True
    return changed

# Experiment 1: keep the existing values and add only enough direction to make the interaction obvious.
p = find_para("click", "parallel paths", "fixed settings")
append_once(p, " The values listed under Fixed Parameters are already set in the simulation and do not need to be entered.", "Fixed Parameters")

p = find_para("for trial 1", "0.00", "8 w")
append_once(p, " Under Adjustable Parameters, click inside each input box and type the Trial 1 value. The allowed range is printed directly below each box. Then click “Run and record trial” and copy the displayed outputs into Table 1.", "Adjustable Parameters")

p = find_para("for trial 2", "0.85", "0 w")
append_once(p, " Change only the two adjustable input boxes to the Trial 2 values. Click “Run and record trial” and copy the displayed outputs into Table 1.", "adjustable input boxes")

p = find_para("for trial 3", "0.85", "8 w")
append_once(p, " Change the two adjustable input boxes to the Trial 3 values. Click “Run and record trial” and copy the displayed outputs into Table 1.", "adjustable input boxes")

# Experiment 2: clarify where the student types the thickness.
p = find_para("continue to series conduction", "fixed settings")
append_once(p, " These values are shown under Fixed Parameters and remain unchanged for Trials 4-6.", "Fixed Parameters")

p = find_para("run trial 4", "0.000")
append_once(p, " Click the Insulation thickness box under Adjustable Parameter, type 0.000, then click “Run and record trial.” The allowed range is shown below the box.", "Adjustable Parameter")

p = find_para("run trial 5", "0.100")
append_once(p, " Replace the value in the same Insulation thickness box with 0.100, click “Run and record trial,” and copy the displayed outputs into Table 2.", "Replace the value")

p = find_para("run trial 6", "0.150")
append_once(p, " Replace the value with 0.150, click “Run and record trial,” and copy the displayed outputs into Table 2.", "Replace the value")

# Experiment 3: two prescribed adjacent thicknesses rather than a trial-and-error search.
replace_para(
    find_para("purpose", "minimum selectable insulation thickness", "60"),
    "Purpose: confirm the minimum selectable insulation thickness that keeps the touchable outer surface at or below 60 °C by comparing two adjacent 0.005 m thickness settings."
)

p = find_para("confirm the fixed settings", "800", "0.080")
append_once(p, " These values are shown under Fixed Parameters and should not be changed.", "Fixed Parameters")

replace_para(
    find_para("use insulation-thickness increments", "0.005"),
    "Under Adjustable Parameter, click the Insulation thickness box, enter 0.105 m, and click “Run and record trial.” Copy the displayed outputs to Trial 7 in Table 3 and note whether the simulation reports PASS or FAIL."
)
replace_para(
    find_para("click", "record current trial", "trial 7"),
    "For Trial 8, change only the insulation thickness to 0.110 m. Click “Run and record trial,” copy the displayed outputs into Table 3, and note the PASS or FAIL result."
)
replace_para(
    find_para("reduce", "0.005", "trial 8"),
    "Compare the two recorded outer-surface temperatures with the 60 °C safety limit. The two thicknesses differ by one selectable increment of 0.005 m."
)
replace_para(
    find_para("mark each run", "pass or fail"),
    "Use the adjacent Trial 7 and Trial 8 results to identify the minimum selectable safe insulation thickness."
)

replace_para(
    find_para("table 3", "surface-safety search"),
    "Table 3. Experimental data for the surface-safety comparison"
)

# Table 3 is the final worksheet table. Prescribe the two adjacent thicknesses.
table3 = doc.tables[-1]
if len(table3.rows) < 3 or len(table3.columns) < 2:
    raise RuntimeError("Safety Table 3 has an unexpected structure")
table3.rows[1].cells[0].text = "7"
table3.rows[1].cells[1].text = "0.105"
table3.rows[2].cells[0].text = "8"
table3.rows[2].cells[1].text = "0.110"

replace_para(
    find_para("why must the setting immediately below trial 7"),
    "10. Trials 7 and 8 differ by one selectable increment of 0.005 m. How do their Pass/Fail results demonstrate the minimum selectable safe thickness?"
)
replace_para(
    find_para("at trial 7", "outer-surface mechanism"),
    "11. At the passing safety trial, which outer-surface mechanism contributes more heat loss? How might that affect the safe thickness if h or ε changed?"
)

# Keep the original professional equation formatting; only change the old minus relation to plus.
safety_intro = find_para("use", "safety decision", "touchable outer-surface")
q9 = find_para("why is the outer-surface temperature", "touch-safety")
paras = doc.paragraphs
i0 = next(i for i,p in enumerate(paras) if p._p is safety_intro._p)
i1 = next(i for i,p in enumerate(paras) if p._p is q9._p)
math_paras = [p for p in paras[i0+1:i1] if "oMath" in p._p.xml]
if not math_paras or not patch_math_operator(math_paras[0], "-", "+"):
    raise RuntimeError("Could not update the Experiment 3 safety equation")

# Align Homework 3 with the same two prescribed thicknesses.
replace_para(
    find_para("question 3", "confirm the minimum selectable safe thickness"),
    "Question 3. Confirm the minimum selectable safe thickness. Use the surface-safety requirement and the two adjacent thicknesses tested in Trials 7 and 8:"
)

trial_report = find_para("for trials 7 and 8", "report the insulation thickness")
replace_para(
    trial_report,
    "For Trials 7 and 8, report the insulation thickness and outer-surface temperature, classify each trial as Pass or Fail, and confirm that the two thicknesses differ by exactly 0.005 m. Explain briefly why a failure at the lower setting and a pass at the next selectable setting show that the passing thickness is the minimum safe thickness selectable using 0.005 m increments."
)

paras = doc.paragraphs
hw3 = find_para("question 3", "two adjacent thicknesses")
i0 = next(i for i,p in enumerate(paras) if p._p is hw3._p)
i1 = next(i for i,p in enumerate(paras) if p._p is trial_report._p)
math_paras = [p for p in paras[i0+1:i1] if "oMath" in p._p.xml]
if not math_paras or not patch_math_operator(math_paras[0], "-", "+"):
    raise RuntimeError("Could not update the Homework 3 safety equation")

# Save the updated worksheet in place for the deployed site.
doc.save(DOCX)

# Keep the legacy alias synchronized inside the deployment artifact.
legacy = BASE / "Panel_Heat_Transfer_Worksheet.docx"
legacy.write_bytes(DOCX.read_bytes())

print("Heat-transfer worksheet updated successfully.")
