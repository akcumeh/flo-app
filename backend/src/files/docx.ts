import { inflateRawSync } from 'node:zlib';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_END = 0x06054b50;
const MAX_XML_BYTES = 50 * 1024 * 1024;
const SOFT_PAGE_CHARS = 3000;

export function isDocx(buffer: Buffer): boolean {
    return (
        buffer.length > 30 &&
        buffer.readUInt32LE(0) === ZIP_LOCAL &&
        buffer.includes('word/document.xml', 0, 'latin1')
    );
}

function zipEntry(zip: Buffer, wanted: string): Buffer | null {
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
        if (zip.readUInt32LE(i) === ZIP_END) {
            end = i;
            break;
        }
    }
    if (end < 0) return null;
    const count = zip.readUInt16LE(end + 10);
    let at = zip.readUInt32LE(end + 16);
    for (let n = 0; n < count && at + 46 <= zip.length; n += 1) {
        if (zip.readUInt32LE(at) !== ZIP_CENTRAL) return null;
        const method = zip.readUInt16LE(at + 10);
        const size = zip.readUInt32LE(at + 20);
        const nameLength = zip.readUInt16LE(at + 28);
        const extraLength = zip.readUInt16LE(at + 30);
        const commentLength = zip.readUInt16LE(at + 32);
        const local = zip.readUInt32LE(at + 42);
        const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
        at += 46 + nameLength + extraLength + commentLength;
        if (name !== wanted) continue;
        if (zip.readUInt32LE(local) !== ZIP_LOCAL) return null;
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + size);
        if (method === 0) return data;
        if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES });
        return null;
    }
    return null;
}

function decode(text: string): string {
    return text
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

const TOKEN =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:lastRenderedPageBreak\/>|<w:br\b([^>]*)\/>|<w:tab\/>|<\/w:p>/g;

function softPages(text: string): string[] {
    const pages: string[] = [];
    let page = '';
    for (const para of text.split('\n')) {
        if (page.length + para.length > SOFT_PAGE_CHARS && page.trim()) {
            pages.push(page);
            page = '';
        }
        page += `${para}\n`;
    }
    if (page.trim()) pages.push(page);
    return pages;
}

export function docxPages(buffer: Buffer): string[] | null {
    let xml: Buffer | null;
    try {
        xml = zipEntry(buffer, 'word/document.xml');
    } catch {
        return null;
    }
    if (!xml) return null;
    const source = xml.toString('utf8');
    let text = '';
    let breaks = 0;
    for (const m of source.matchAll(TOKEN)) {
        if (m[1] !== undefined) text += decode(m[1]);
        else if (m[0] === '<w:tab/>') text += '\t';
        else if (m[0] === '</w:p>') text += '\n';
        else if (m[0] === '<w:lastRenderedPageBreak/>' || /w:type="page"/.test(m[2] ?? '')) {
            text += '\f';
            breaks += 1;
        } else text += '\n';
    }
    if (breaks === 0) return softPages(text);
    const pages = text.split('\f');
    while (pages.length > 1 && !pages[pages.length - 1].trim()) pages.pop();
    return pages;
}
