import { deflateRawSync } from 'node:zlib';
export function makePdf(pages: string[]): Buffer {
    const objects: string[] = [];
    const pageIds = pages.map((_, i) => 4 + i * 2);
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((text, i) => {
        const lines = text.split('\n').map((l) => l.replace(/[\\()]/g, '\\$&'));
        const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
        objects[4 + i * 2] =
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
        objects[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id += 1) {
        offsets[id] = Buffer.byteLength(out, 'latin1');
        out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1)
        out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

export function fakePng(seed: number): Buffer {
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(`fake-png-${seed}`),
    ]);
}

export function makeZip(entries: Record<string, string>): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
        const raw = Buffer.from(text, 'utf8');
        const data = deflateRawSync(raw);
        const nameBuf = Buffer.from(name, 'utf8');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + data.length;
    }
    const dir = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}

export function makeDocx(pages: string[]): Buffer {
    const para = (t: string) =>
        `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
    const body = pages
        .map(
            (p, i) =>
                (i > 0 ? '<w:p><w:r><w:lastRenderedPageBreak/></w:r></w:p>' : '') +
                p.split('\n').map(para).join('')
        )
        .join('');
    return makeZip({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
    });
}
