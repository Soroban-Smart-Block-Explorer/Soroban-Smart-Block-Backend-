/**
 * Minimal PDF Engine — zero external dependencies
 *
 * Generates ISO 32000-compliant PDF 1.4 documents.
 * Supports: text, lines, rectangles, polygons, colours, multiple pages,
 * embedded Helvetica (Type1 built-in), and streaming byte output.
 *
 * Usage:
 *   const doc = new PdfDocument();
 *   const page = doc.addPage();
 *   page.setFont('Helvetica-Bold', 16);
 *   page.text('Hello', 72, 700);
 *   const bytes = doc.build();
 */

// ── Types ─────────────────────────────────────────────────────────────────────

type Color = { r: number; g: number; b: number }; // 0-255 each

// ── PDF cross-reference builder ───────────────────────────────────────────────

export class PdfDocument {
  private objects: string[] = []; // indexed from 1
  private pageIds: number[] = [];
  private catalogId = 0;
  private pagesId = 0;

  constructor() {
    // Reserve obj 1 = catalog, obj 2 = pages
    this.catalogId = this.reserveObj();
    this.pagesId = this.reserveObj();
  }

  private reserveObj(): number {
    this.objects.push(''); // placeholder
    return this.objects.length; // 1-based
  }

  private setObj(id: number, content: string): void {
    this.objects[id - 1] = content;
  }

  private nextId(): number {
    this.objects.push('');
    return this.objects.length;
  }

  // ── Page factory ────────────────────────────────────────────────────────────

  addPage(width = 595, height = 842): PdfPage {
    const contentId = this.nextId();
    const pageId = this.nextId();
    this.pageIds.push(pageId);
    const page = new PdfPage(width, height, contentId, pageId, this);
    return page;
  }

  // Called by PdfPage.seal()
  _commitPage(
    pageId: number,
    contentId: number,
    contentStream: string,
    width: number,
    height: number,
  ): void {
    const streamBytes = Buffer.from(contentStream, 'latin1');
    const streamLen = streamBytes.length;

    this.setObj(
      contentId,
      [
        `${contentId} 0 obj`,
        `<< /Length ${streamLen} >>`,
        'stream',
        contentStream,
        'endstream',
        'endobj',
      ].join('\n'),
    );

    this.setObj(
      pageId,
      [
        `${pageId} 0 obj`,
        '<< /Type /Page',
        `   /Parent ${this.pagesId} 0 R`,
        `   /MediaBox [0 0 ${width} ${height}]`,
        `   /Contents ${contentId} 0 R`,
        '   /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> /F3 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >> >> >>',
        '>>',
        'endobj',
      ].join('\n'),
    );
  }

  // ── Build final PDF bytes ───────────────────────────────────────────────────

  build(): Buffer {
    // Finalise catalog + pages
    const kidsRef = this.pageIds.map((id) => `${id} 0 R`).join(' ');
    this.setObj(
      this.pagesId,
      [
        `${this.pagesId} 0 obj`,
        `<< /Type /Pages /Kids [${kidsRef}] /Count ${this.pageIds.length} >>`,
        'endobj',
      ].join('\n'),
    );

    this.setObj(
      this.catalogId,
      [`${this.catalogId} 0 obj`, `<< /Type /Catalog /Pages ${this.pagesId} 0 R >>`, 'endobj'].join(
        '\n',
      ),
    );

    // Assemble body
    const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const parts: string[] = [header];
    const offsets: number[] = [];
    let offset = Buffer.byteLength(header, 'latin1');

    for (let i = 0; i < this.objects.length; i++) {
      offsets.push(offset);
      const chunk = this.objects[i] + '\n';
      parts.push(chunk);
      offset += Buffer.byteLength(chunk, 'latin1');
    }

    // Cross-reference table
    const xrefOffset = offset;
    const xref =
      [
        'xref',
        `0 ${this.objects.length + 1}`,
        '0000000000 65535 f \n' +
          offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `).join('\n'),
      ].join('\n') + '\n';
    parts.push(xref);

    const trailer = [
      'trailer',
      `<< /Size ${this.objects.length + 1} /Root ${this.catalogId} 0 R >>`,
      'startxref',
      String(xrefOffset),
      '%%EOF',
    ].join('\n');
    parts.push(trailer);

    return Buffer.from(parts.join(''), 'latin1');
  }
}

// ── Page drawing API ──────────────────────────────────────────────────────────

export class PdfPage {
  readonly width: number;
  readonly height: number;
  private ops: string[] = [];
  private sealed = false;
  private currentFont = 'F1';
  private currentFontSize = 12;

  constructor(
    width: number,
    height: number,
    private contentId: number,
    private pageId: number,
    private doc: PdfDocument,
  ) {
    this.width = width;
    this.height = height;
  }

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  // PDF origin is bottom-left; all public methods take top-left Y for convenience.
  private py(y: number): number {
    return this.height - y;
  }

  // ── PDF operators ──────────────────────────────────────────────────────────

  private rgb(c: Color): string {
    return `${(c.r / 255).toFixed(3)} ${(c.g / 255).toFixed(3)} ${(c.b / 255).toFixed(3)}`;
  }

  /** Set fill colour (rg). */
  fillColor(c: Color): this {
    this.ops.push(`${this.rgb(c)} rg`);
    return this;
  }

  /** Set stroke colour (RG). */
  strokeColor(c: Color): this {
    this.ops.push(`${this.rgb(c)} RG`);
    return this;
  }

  /** Set line width. */
  lineWidth(w: number): this {
    this.ops.push(`${w.toFixed(2)} w`);
    return this;
  }

  /** Filled rectangle. x,y = top-left. */
  rect(x: number, y: number, w: number, h: number, fill = true, stroke = false): this {
    this.ops.push(
      `${x.toFixed(2)} ${this.py(y + h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re`,
    );
    if (fill && stroke) this.ops.push('B');
    else if (fill) this.ops.push('f');
    else if (stroke) this.ops.push('S');
    return this;
  }

  /** Stroked rectangle with optional rounded hint (PDF has no native rounded rects). */
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    fill: boolean,
    stroke: boolean,
  ): this {
    const py = (ty: number) => this.py(ty);
    const x0 = x + r,
      x1 = x + w - r;
    const y0 = py(y + h) + r,
      y1 = py(y) - r;
    this.ops.push(
      `${x0.toFixed(2)} ${py(y + h).toFixed(2)} m`,
      `${x1.toFixed(2)} ${py(y + h).toFixed(2)} l`,
      `${(x + w).toFixed(2)} ${py(y + h).toFixed(2)} ${(x + w).toFixed(2)} ${y0.toFixed(2)} ${r.toFixed(2)} ${r.toFixed(2)} c`,
      `${(x + w).toFixed(2)} ${y1.toFixed(2)} l`,
      `${(x + w).toFixed(2)} ${py(y).toFixed(2)} ${x1.toFixed(2)} ${py(y).toFixed(2)} ${r.toFixed(2)} ${r.toFixed(2)} c`,
      `${x0.toFixed(2)} ${py(y).toFixed(2)} l`,
      `${x.toFixed(2)} ${py(y).toFixed(2)} ${x.toFixed(2)} ${y1.toFixed(2)} ${r.toFixed(2)} ${r.toFixed(2)} c`,
      `${x.toFixed(2)} ${y0.toFixed(2)} l`,
      `${x.toFixed(2)} ${py(y + h).toFixed(2)} ${x0.toFixed(2)} ${py(y + h).toFixed(2)} ${r.toFixed(2)} ${r.toFixed(2)} c`,
      'h',
    );
    if (fill && stroke) this.ops.push('B');
    else if (fill) this.ops.push('f');
    else if (stroke) this.ops.push('S');
    return this;
  }

  /** Draw a straight line. */
  line(x1: number, y1: number, x2: number, y2: number): this {
    this.ops.push(
      `${x1.toFixed(2)} ${this.py(y1).toFixed(2)} m`,
      `${x2.toFixed(2)} ${this.py(y2).toFixed(2)} l S`,
    );
    return this;
  }

  /** Filled polygon (array of [x,y] in top-left coords). */
  polygon(points: [number, number][], fill = true, stroke = false): this {
    if (points.length < 2) return this;
    const [fx, fy] = points[0];
    this.ops.push(`${fx.toFixed(2)} ${this.py(fy).toFixed(2)} m`);
    for (let i = 1; i < points.length; i++) {
      const [px, py] = points[i];
      this.ops.push(`${px.toFixed(2)} ${this.py(py).toFixed(2)} l`);
    }
    this.ops.push('h');
    if (fill && stroke) this.ops.push('B');
    else if (fill) this.ops.push('f');
    else if (stroke) this.ops.push('S');
    return this;
  }

  /** Draw a circle (approximated with 4 Bézier arcs). */
  circle(cx: number, cy: number, r: number, fill = true, stroke = false): this {
    const k = 0.5523;
    const pcy = this.py(cy);
    this.ops.push(
      `${cx.toFixed(2)} ${(pcy + r).toFixed(2)} m`,
      `${(cx + r * k).toFixed(2)} ${(pcy + r).toFixed(2)} ${(cx + r).toFixed(2)} ${(pcy + r * k).toFixed(2)} ${(cx + r).toFixed(2)} ${pcy.toFixed(2)} c`,
      `${(cx + r).toFixed(2)} ${(pcy - r * k).toFixed(2)} ${(cx + r * k).toFixed(2)} ${(pcy - r).toFixed(2)} ${cx.toFixed(2)} ${(pcy - r).toFixed(2)} c`,
      `${(cx - r * k).toFixed(2)} ${(pcy - r).toFixed(2)} ${(cx - r).toFixed(2)} ${(pcy - r * k).toFixed(2)} ${(cx - r).toFixed(2)} ${pcy.toFixed(2)} c`,
      `${(cx - r).toFixed(2)} ${(pcy + r * k).toFixed(2)} ${(cx - r * k).toFixed(2)} ${(pcy + r).toFixed(2)} ${cx.toFixed(2)} ${(pcy + r).toFixed(2)} c h`,
    );
    if (fill && stroke) this.ops.push('B');
    else if (fill) this.ops.push('f');
    else if (stroke) this.ops.push('S');
    return this;
  }

  // ── Text ───────────────────────────────────────────────────────────────────

  /**
   * Select font: 'regular' | 'bold' | 'italic'
   * Maps to F1 (Helvetica), F2 (Helvetica-Bold), F3 (Helvetica-Oblique)
   */
  setFont(style: 'regular' | 'bold' | 'italic', size: number): this {
    this.currentFont = style === 'bold' ? 'F2' : style === 'italic' ? 'F3' : 'F1';
    this.currentFontSize = size;
    return this;
  }

  /** Place a single text string. x,y = top-left baseline. */
  text(str: string, x: number, y: number): this {
    const safe = this.escapeStr(str);
    this.ops.push(
      'BT',
      `/${this.currentFont} ${this.currentFontSize} Tf`,
      `${x.toFixed(2)} ${this.py(y).toFixed(2)} Td`,
      `(${safe}) Tj`,
      'ET',
    );
    return this;
  }

  /**
   * Word-wrapped text block. Returns the Y position after the last line.
   * charWidth is an approximation: 0.6 * fontSize for Helvetica.
   */
  textWrapped(str: string, x: number, y: number, maxWidth: number, lineHeight?: number): number {
    const lh = lineHeight ?? this.currentFontSize * 1.4;
    const charW = this.currentFontSize * 0.52;
    const charsPerLine = Math.max(1, Math.floor(maxWidth / charW));

    const words = str.split(' ');
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length > charsPerLine && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    let curY = y;
    for (const line of lines) {
      this.text(line, x, curY);
      curY += lh;
    }
    return curY;
  }

  /** Approximate text width in points (Helvetica approximation). */
  measureText(str: string): number {
    return str.length * this.currentFontSize * 0.52;
  }

  /** Centre-aligned text in a horizontal span. */
  textCentered(str: string, x: number, width: number, y: number): this {
    const tw = this.measureText(str);
    const tx = x + (width - tw) / 2;
    return this.text(str, Math.max(x, tx), y);
  }

  /** Right-aligned text. */
  textRight(str: string, rightX: number, y: number): this {
    const tw = this.measureText(str);
    return this.text(str, rightX - tw, y);
  }

  private escapeStr(s: string): string {
    return s
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[^\x20-\x7E]/g, '?'); // strip non-ASCII
  }

  // ── Seal page ──────────────────────────────────────────────────────────────

  /** Finalise and commit the page to the parent document. */
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    const stream = this.ops.join('\n');
    this.doc._commitPage(this.pageId, this.contentId, stream, this.width, this.height);
  }
}
