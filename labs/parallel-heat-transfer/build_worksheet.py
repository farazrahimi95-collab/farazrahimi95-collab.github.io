from pathlib import Path
import base64
import io
import shutil
import zipfile

BASE = Path(__file__).resolve().parent
PATCH_DIR = BASE / ".worksheet_patch"
BASE_DOCX = BASE / "Parallel_Heat_Transfer_Worksheet.docx"
FINAL_DOCX = BASE / "Heat Transfer Worksheet.docx"

PATCH_PARTS = [
    "part01.b64",
    "part02.b64",
    "part03a.b64",
    "part03b.b64",
    "part04a.b64",
    "part04b.b64",
    "part05.b64",
    "part06a.b64",
    "part06b.b64",
    "part07.b64",
]

# Preserve the exact OOXML package structure and member order of the Word file
# supplied by the worksheet author. Members not present in the patch are copied
# byte-for-byte from the previously published worksheet.
EXPECTED_MEMBERS = [
    "[Content_Types].xml",
    "_rels/.rels",
    "word/document.xml",
    "word/_rels/document.xml.rels",
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/header1.xml",
    "word/footer1.xml",
    "word/media/image1.jpeg",
    "word/media/image2.png",
    "word/media/image3.png",
    "word/media/image4.png",
    "word/theme/theme1.xml",
    "word/settings.xml",
    "word/numbering.xml",
    "word/styles.xml",
    "word/webSettings.xml",
    "word/fontTable.xml",
    "docProps/core.xml",
    "docProps/app.xml",
    "docProps/custom.xml",
]

patch_b64 = "".join((PATCH_DIR / name).read_text(encoding="ascii").strip() for name in PATCH_PARTS)
patch_bytes = base64.b64decode(patch_b64)

with zipfile.ZipFile(BASE_DOCX, "r") as base_zip:
    base_data = {name: base_zip.read(name) for name in base_zip.namelist()}

with zipfile.ZipFile(io.BytesIO(patch_bytes), "r") as patch_zip:
    patch_data = {name: patch_zip.read(name) for name in patch_zip.namelist()}

missing = [name for name in EXPECTED_MEMBERS if name not in patch_data and name not in base_data]
if missing:
    raise RuntimeError(f"Cannot reconstruct worksheet; missing members: {missing}")

with zipfile.ZipFile(FINAL_DOCX, "w", compression=zipfile.ZIP_DEFLATED) as out_zip:
    for name in EXPECTED_MEMBERS:
        out_zip.writestr(name, patch_data[name] if name in patch_data else base_data[name])

# Validate that the generated Word file contains the intended package exactly.
with zipfile.ZipFile(FINAL_DOCX, "r") as check_zip:
    if check_zip.namelist() != EXPECTED_MEMBERS:
        raise RuntimeError("Generated worksheet package member order does not match the reviewed Word file.")
    for name in EXPECTED_MEMBERS:
        expected = patch_data[name] if name in patch_data else base_data[name]
        if check_zip.read(name) != expected:
            raise RuntimeError(f"Generated worksheet member differs from the reviewed Word file: {name}")

# Keep old URLs working while the site transitions to the author's new filename.
shutil.copyfile(FINAL_DOCX, BASE / "Parallel_Heat_Transfer_Worksheet.docx")
shutil.copyfile(FINAL_DOCX, BASE / "Panel_Heat_Transfer_Worksheet.docx")

print(f"Published exact worksheet content as: {FINAL_DOCX.name}")
