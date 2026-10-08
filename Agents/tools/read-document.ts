import 'server-only';

import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentError, type Tool } from '../types';

/**
 * Turns a source file into text the Researcher can read.
 *
 * The Source Analyzer skill has always declared a `read_source_file` tool, but
 * nothing implemented it — so the analyzer was handed a list of *filenames*
 * and asked to extract facts from them, which is a request to hallucinate. A
 * deck built from supplied documents has to actually open the documents.
 *
 * Extraction only. No summarising, no chunking, no judgement about what
 * matters — that is the Researcher's job, and mixing the two would put a model
 * between the file and the facts twice.
 */

/** Text pulled out of a document is capped: a textbook is not a prompt. */
const MAX_CHARS = 60_000;
/** Refuse to even read a file bigger than this. */
const MAX_BYTES = 40 * 1024 * 1024;

export interface ReadDocumentInput {
  filePath: string;
}

export interface ReadDocumentOutput {
  filePath: string;
  /** Basename, which is what a citation should say. */
  name: string;
  format: 'pdf' | 'docx' | 'text' | 'html' | 'unsupported';
  text: string;
  /** Set when the document was longer than `MAX_CHARS`. */
  truncated: boolean;
  /** Pages, for a PDF. Undefined for formats with no page concept. */
  pages?: number;
}

/**
 * Roots a document may be read from.
 *
 * `read_document` is in the tool registry, which means a skill can name it and
 * model output can reach its arguments. The path is therefore untrusted, and
 * "read any file on the server" is not a capability this pipeline needs — it
 * reads the drop folder and the per-build temp dir, and nothing else.
 */
function allowedRoots(): string[] {
  return [path.resolve(process.cwd(), 'Documents'), path.resolve(tmpdir())];
}

function assertReadable(filePath: string): string {
  const resolved = path.resolve(filePath);
  const roots = allowedRoots();

  const inside = roots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });

  if (!inside) {
    throw new AgentError(
      `Refusing to read ${resolved}: source documents must live under ${roots.join(' or ')}`,
      'DOCUMENT_PATH_FORBIDDEN',
      'read-document',
    );
  }

  return resolved;
}

/** Strips tags and entities well enough to read prose out of an HTML file. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}

/**
 * PDF text, page by page.
 *
 * `pdf-parse` wraps pdfjs, which holds a document handle open — hence the
 * `destroy()` in a finally. Imported lazily because pdfjs is heavy and most
 * builds have no PDF in them at all.
 */
async function readPdf(resolved: string): Promise<{ text: string; pages: number }> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(await readFile(resolved)) });

  try {
    const result = await parser.getText();
    return { text: result.text, pages: result.total };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

/** DOCX text. Mammoth's raw extraction — styling is irrelevant to research. */
async function readDocx(resolved: string): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ path: resolved });
  return value;
}

export const readDocument: Tool<ReadDocumentInput, ReadDocumentOutput> = {
  name: 'read_document',
  description:
    'Reads a source document (pdf, docx, txt, md, csv, json, html) from the drop folder or the current build and returns its plain text.',

  async execute({ filePath }) {
    if (!filePath?.trim()) {
      throw new AgentError(
        'read_document needs a filePath',
        'DOCUMENT_PATH_MISSING',
        'read-document',
      );
    }

    const resolved = assertReadable(filePath);
    const name = path.basename(resolved);
    const extension = path.extname(resolved).toLowerCase();

    const info = await stat(resolved).catch(() => null);
    if (!info?.isFile()) {
      throw new AgentError(`No such document: ${resolved}`, 'DOCUMENT_NOT_FOUND', 'read-document');
    }
    if (info.size > MAX_BYTES) {
      throw new AgentError(
        `${name} is ${Math.round(info.size / 1e6)}MB — too large to extract in a build`,
        'DOCUMENT_TOO_LARGE',
        'read-document',
      );
    }

    let text: string;
    let format: ReadDocumentOutput['format'];
    let pages: number | undefined;

    switch (extension) {
      case '.pdf': {
        const parsed = await readPdf(resolved);
        text = parsed.text;
        pages = parsed.pages;
        format = 'pdf';
        break;
      }
      case '.docx':
        text = await readDocx(resolved);
        format = 'docx';
        break;
      case '.html':
      case '.htm':
        text = htmlToText(await readFile(resolved, 'utf8'));
        format = 'html';
        break;
      case '.txt':
      case '.md':
      case '.markdown':
      case '.csv':
      case '.tsv':
      case '.json':
        text = await readFile(resolved, 'utf8');
        format = 'text';
        break;
      default:
        // Reported, not thrown: one unreadable file among five should narrow
        // the research, not end the build.
        return {
          filePath: resolved,
          name,
          format: 'unsupported',
          text: '',
          truncated: false,
        };
    }

    const normalised = text.replace(/\r\n/g, '\n').trim();

    return {
      filePath: resolved,
      name,
      format,
      text: normalised.slice(0, MAX_CHARS),
      truncated: normalised.length > MAX_CHARS,
      pages,
    };
  },
};
