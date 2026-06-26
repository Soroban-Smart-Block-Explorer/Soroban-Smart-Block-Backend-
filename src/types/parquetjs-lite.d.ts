declare module 'parquetjs-lite' {
  export class ParquetReader {
    static openFile(filePath: string): Promise<ParquetReader>;
    getCursor(): ParquetCursor;
    close(): Promise<void>;
    metadata: any;
    schema: any;
  }

  export interface ParquetCursor {
    next(): Promise<any>;
  }

  export class ParquetWriter {
    static openFile(schema: ParquetSchema, filePath: string, opts?: any): Promise<ParquetWriter>;
    appendRow(row: any): Promise<void>;
    close(): Promise<void>;
  }

  export class ParquetSchema {
    constructor(fields: Record<string, { type: string; optional?: boolean }>);
  }
}
