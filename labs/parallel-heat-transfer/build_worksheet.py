from pathlib import Path
from copy import deepcopy
from docx import Document

BASE = Path(__file__).resolve().parent
DOCX = BASE / "Parallel_Heat_Transfer_Worksheet.docx"

doc = Document(DOCX)

def norm(text):
    return " ".join(
        (text or "")
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .split()
    ).lower()

def find_para(*needles):
    wanted = [x.lower() for x in needles]
    for p in doc.paragraphs:
        t = norm(p.text)
        if all(x in t for x in wanted):
            return p
    raise RuntimeError("Paragraph not found: " + " | ".join(needles))

def add_text(p, text):
    p.add_run(text)

def add_var(p, base, sub=None):
    r = p.add_run(base)
    r.italic = True
    if sub is not None:
        r = p.add_run(sub)
        r.italic = True
        r.font.subscript = True

def rewrite_stage1_intro(p):
    p.clear()
    add_text(p, 'Click “Parallel paths”. The Fixed Parameters cannot be changed: ')
    add_var(p, 'T', 'in')
    add_text(p, ' = 800 °C, ')
    add_var(p, 't', 'ins')
    add_text(p, ' = 0.100 m, ')
    add_var(p, 'k', 'ins')
    add_text(p, ' = 0.080 W/(m·K), and ')
    add_var(p, 'T', '∞')
    add_text(p, ' = 25 °C. The Adjustable Parameters are emissivity, ε, and convection coefficient, h. Click inside the highlighted input boxes to enter the trial values; the allowed range is shown below each box.')

def rewrite_stage2_intro(p):
    p.clear()
    add_text(p, 'Click “Continue to series conduction”. The Fixed Parameters cannot be changed: ')
    add_var(p, 'T', 'in')
    add_text(p, ' = 800 °C, ')
    add_var(p, 'k', 'ins')
    add_text(p, ' = 0.080 W/(m·K), h = 8 W/(m²·K), ε = 0.85, and ')
    add_var(p, 'T', '∞')
    add_text(p, ' = 25 °C. The Adjustable Parameter is insulation thickness, ')
    add_var(p, 't', 'ins')
    add_text(p, '. Click inside the highlighted input box to enter the trial value; the allowed range is shown below the box.')

def rewrite_stage3_intro(p):
    p.clear()
    add_text(p, 'Click “Continue to safety limit”. The Fixed Parameters cannot be changed: ')
    add_var(p, 'T', 'in')
    add_text(p, ' = 800 °C, ')
    add_var(p, 'k', 'ins')
    add_text(p, ' = 0.080 W/(m·K), h = 8 W/(m²·K), ε = 0.85, ')
    add_var(p, 'T', '∞')
    add_text(p, ' = 25 °C, and safety limit ')
    add_var(p, 'T', 's')
    add_text(p, ' = 60 °C. The Adjustable Parameter is insulation thickness, ')
    add_var(p, 't', 'ins')
    add_text(p, '. Click inside the highlighted input box to enter the specified trial thickness.')

def patch_math_operator(p, old="-", new="+"):
    changed = False
    math_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/math}t"
    for node in p._p.iter(math_ns):
        if node.text == old:
            node.text = new
            changed = True
    return changed

def split_math_t_in_subscripts():
    """Work around PDF rendering that can drop the n when OMML stores 'in' in one math run."""
    math = "http://schemas.openxmlformats.org/officeDocument/2006/math"
    def node_text(node):
        if node is None:
            return ""
        return "".join((t.text or "") for t in node.iter(f"{{{math}}}t"))
    changed = 0
    for p in doc.paragraphs:
        for ssub in p._p.iter(f"{{{math}}}sSub"):
            base = ssub.find(f"{{{math}}}e")
            sub = ssub.find(f"{{{math}}}sub")
            if node_text(base) != "T" or node_text(sub) != "in":
                continue
            runs = [node for node in list(sub) if node.tag == f"{{{math}}}r"]
            if not runs:
                continue
            first = runs[0]
            first_text = next(first.iter(f"{{{math}}}t"), None)
            if first_text is None:
                continue
            first_text.text = "i"
            second = deepcopy(first)
            second_text = next(second.iter(f"{{{math}}}t"), None)
            second_text.text = "n"
            sub.insert(list(sub).index(first) + 1, second)
            changed += 1
    return changed

# Experiment 1: direct students to the visible fixed and adjustable groups.
rewrite_stage1_intro(find_para("click", "parallel paths", "fixed settings"))

p = find_para("for trial 1", "0.00", "8 w")
p.clear()
add_text(p, 'For Trial 1, enter ε = 0.00 and h = 8 W/(m²·K) in the highlighted Adjustable Parameters boxes. Click “Run and record trial” and copy the displayed outputs into Table 1.')

p = find_para("for trial 2", "0.85", "0 w")
p.clear()
add_text(p, 'For Trial 2, enter ε = 0.85 and h = 0 W/(m²·K) in the same highlighted boxes. Click “Run and record trial” and copy the displayed outputs into Table 1.')

p = find_para("for trial 3", "0.85", "8 w")
p.clear()
add_text(p, 'For Trial 3, enter ε = 0.85 and h = 8 W/(m²·K) in the same highlighted boxes. Click “Run and record trial” and copy the displayed outputs into Table 1.')

# Experiment 2: replace the ambiguous "fixed settings" wording and keep T_in as one clean subscript.
rewrite_stage2_intro(find_para("continue to series conduction", "fixed settings"))

p = find_para("run trial 4", "0.000")
p.clear()
add_text(p, 'For Trial 4, click the highlighted Insulation thickness box, enter 0.000 m, then click “Run and record trial” and copy the displayed outputs into Table 2.')

p = find_para("run trial 5", "0.100")
p.clear()
add_text(p, 'For Trial 5, replace the insulation thickness with 0.100 m, click “Run and record trial,” and copy the displayed outputs into Table 2.')

p = find_para("run trial 6", "0.150")
p.clear()
add_text(p, 'For Trial 6, replace the insulation thickness with 0.150 m, click “Run and record trial,” and copy the displayed outputs into Table 2.')

# Experiment 3: two prescribed adjacent thicknesses rather than a trial-and-error search.
p = find_para("purpose", "minimum selectable insulation thickness", "60")
p.clear()
add_text(p, "Purpose: confirm the minimum selectable insulation thickness that keeps the touchable outer surface at or below 60 °C by comparing two adjacent 0.005 m thickness settings.")

# This replaces "Confirm the fixed settings" entirely and also fixes the broken T_in subscript.
rewrite_stage3_intro(find_para("confirm the fixed settings", "800", "0.080"))

p = find_para("use insulation-thickness increments", "0.005")
p.clear()
add_text(p, 'For Trial 7, click the highlighted Insulation thickness box, enter 0.105 m, then click “Run and record trial.” Copy the displayed outputs into Table 3 and note whether the simulation reports PASS or FAIL.')

p = find_para("click", "record current trial", "trial 7")
p.clear()
add_text(p, 'For Trial 8, change only the insulation thickness to 0.110 m. Click “Run and record trial,” copy the displayed outputs into Table 3, and note the PASS or FAIL result.')

p = find_para("reduce", "0.005", "trial 8")
p.clear()
add_text(p, 'Compare the two recorded outer-surface temperatures with the 60 °C safety limit. The two thicknesses differ by one selectable increment of 0.005 m.')

p = find_para("mark each run", "pass or fail")
p.clear()
add_text(p, 'Use the adjacent Trial 7 and Trial 8 results to identify the minimum selectable safe insulation thickness.')

p = find_para("table 3", "surface-safety search")
p.text = "Table 3. Experimental data for the surface-safety comparison"

# Table 3 is the final worksheet table.
table3 = doc.tables[-1]
if len(table3.rows) < 3 or len(table3.columns) < 2:
    raise RuntimeError("Safety Table 3 has an unexpected structure")
table3.rows[1].cells[0].text = "7"
table3.rows[1].cells[1].text = "0.105"
table3.rows[2].cells[0].text = "8"
table3.rows[2].cells[1].text = "0.110"

p = find_para("why must the setting immediately below trial 7")
p.text = "10. Trials 7 and 8 differ by one selectable increment of 0.005 m. How do their Pass/Fail results demonstrate the minimum selectable safe thickness?"

p = find_para("at trial 7", "outer-surface mechanism")
p.text = "11. At the passing safety trial, which outer-surface mechanism contributes more heat loss? How might that affect the safe thickness if h or ε changed?"

# Keep the original professional equation formatting; only change the old minus relation to plus.
safety_intro = find_para("use", "safety decision", "touchable outer-surface")
q9 = find_para("why is the outer-surface temperature", "touch-safety")
paras = doc.paragraphs
i0 = next(i for i, p in enumerate(paras) if p._p is safety_intro._p)
i1 = next(i for i, p in enumerate(paras) if p._p is q9._p)
math_paras = [p for p in paras[i0 + 1:i1] if "oMath" in p._p.xml]
if not math_paras or not patch_math_operator(math_paras[0], "-", "+"):
    raise RuntimeError("Could not update the Experiment 3 safety equation")

# Align Homework 3 with the same two prescribed thicknesses.
p = find_para("question 3", "confirm the minimum selectable safe thickness")
p.text = "Question 3. Confirm the minimum selectable safe thickness. Use the surface-safety requirement and the two adjacent thicknesses tested in Trials 7 and 8:"

trial_report = find_para("for trials 7 and 8", "report the insulation thickness")
trial_report.text = "For Trials 7 and 8, report the insulation thickness and outer-surface temperature, classify each trial as Pass or Fail, and confirm that the two thicknesses differ by exactly 0.005 m. Explain briefly why a failure at the lower setting and a pass at the next selectable setting show that the passing thickness is the minimum safe thickness selectable using 0.005 m increments."

paras = doc.paragraphs
hw3 = find_para("question 3", "two adjacent thicknesses")
i0 = next(i for i, p in enumerate(paras) if p._p is hw3._p)
i1 = next(i for i, p in enumerate(paras) if p._p is trial_report._p)
math_paras = [p for p in paras[i0 + 1:i1] if "oMath" in p._p.xml]
if not math_paras or not patch_math_operator(math_paras[0], "-", "+"):
    raise RuntimeError("Could not update the Homework 3 safety equation")

# Ensure every displayed mathematical T_in renders with both subscript letters.
patched_tin = split_math_t_in_subscripts()
if patched_tin < 2:
    raise RuntimeError(f"Expected to repair at least two T_in math expressions; repaired {patched_tin}")

doc.save(DOCX)

# Keep the legacy alias synchronized in the deployment artifact.
legacy = BASE / "Panel_Heat_Transfer_Worksheet.docx"
legacy.write_bytes(DOCX.read_bytes())

print("Heat-transfer worksheet updated successfully.")
