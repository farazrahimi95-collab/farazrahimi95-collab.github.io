# Virtual Lab

Free interactive engineering virtual laboratories created by Faraz Rahimi.

## Included laboratory

- **ONPG Bead Reactor:** an undergraduate virtual laboratory covering immobilized-enzyme bead size, mass-transfer limitations, Michaelis–Menten kinetics, and bead design.
- Student worksheet in PDF and editable Word formats.
- Browser-based result storage; no student account is required.

## Website structure

```text
index.html                         Home page
site.css                          Home-page appearance
labs/onpg/index.html               ONPG laboratory interface
labs/onpg/styles.css               ONPG laboratory appearance
labs/onpg/app.js                   Experiment data and simulation behavior
labs/onpg/ONPG_Virtual_Lab_Worksheet.pdf
labs/onpg/ONPG_Virtual_Lab_Worksheet.docx
```

## Edit the website

GitHub allows the owner to edit any text file directly in the browser:

1. Open the file in the repository.
2. Select the pencil icon.
3. Make the change and select **Commit changes**.
4. GitHub Pages republishes the website automatically.

Edit `index.html` to change the home-page wording. Laboratory content and calculations are in `labs/onpg/index.html` and `labs/onpg/app.js`. Do not change `app.js` numerical values unless the scientific model or supplied laboratory dataset is intentionally being revised.

## Add another laboratory

1. Create a new folder under `labs/`, such as `labs/parallel-heat-transfer/`.
2. Place that laboratory's web files in the new folder.
3. Add a laboratory card and launch link to `index.html`.
4. Commit the files; deployment runs automatically.

## Ownership

Copyright Faraz Rahimi. All rights reserved.
