#set page(width: 148mm, height: 105mm, margin: 14mm)
#set text(font: "Libertinus Serif", size: 12pt)
#set heading(numbering: "1.")

= Viewer compatibility smoke test

This compact document exercises the Academic PDF Viewer integration without
requiring network access. Hold Control over citation #link(<preview-target>)[20]
to preview its destination.

The first page deliberately keeps the linked number inside ordinary text so
the PDF.js text and annotation layers overlap at the pointer target.

#pagebreak()

= Preview destination <preview-target>

The preview should open on this page, show this nearby text, and render an image
without waiting for PNG cache encoding.
