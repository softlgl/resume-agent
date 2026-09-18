// pdfjs-dist v6 无 exports 子路径类型，声明用到的最小接口（legacy build 用于 Node 环境）
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const GlobalWorkerOptions: { workerSrc: string; workerPort: unknown };

  export interface PDFTextItem {
    str: string;
  }
  export interface PDFViewport {
    width: number;
    height: number;
  }
  export interface PDFPageProxy {
    getViewport(params: { scale: number }): PDFViewport;
    getTextContent(): Promise<{ items: PDFTextItem[] }>;
    render(params: { canvasContext: unknown; viewport: PDFViewport }): { promise: Promise<unknown> };
  }
  export interface PDFDocumentProxy {
    numPages: number;
    getPage(index: number): Promise<PDFPageProxy>;
  }
  export interface PDFDocumentLoadingTask {
    promise: Promise<PDFDocumentProxy>;
    destroy(): Promise<void>;
  }
  export function getDocument(src: {
    data: Uint8Array;
    standardFontDataUrl?: string;
  }): PDFDocumentLoadingTask;
}