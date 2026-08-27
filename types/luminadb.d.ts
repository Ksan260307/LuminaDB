// LuminaDB の公開 API の型。実装は素のスクリプトなので、ここは手書きで追随させる。
// window.LuminaDB（ブラウザ）と index.mjs（Node / Bun）で同じ形を指す。

/** 1 行ぶんの結果。列名 -> 値 */
export type Row = Record<string, string | number | boolean | null>;

/** executeQuery / LuminaDB.query の戻り。エラーは throw ではなく error に入る */
export interface QueryResult {
  data?: Row[];
  error?: string;
  /** 実行時間 (ms) */
  executionTime?: number;
  /** 走査した行数 */
  scannedRows?: number;
}

export interface SelectOptions {
  columns?: string[];
  where?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** SQL エンジン本体 */
export declare class DatabaseEngine {
  constructor();
  /** 文単位の時間上限 (ms)。0 で無制限（既定） */
  statementTimeoutMs: number;
  /** 書き込みを拒否する */
  readOnly: boolean;
  /** 1 文を実行する */
  executeQuery(sql: string): QueryResult;
  /** ';' 区切りの複数文を順に実行する */
  executeScript(sql: string): QueryResult;
  /** ';' 区切りの文へ分解する（文字列リテラル・BEGIN...END を考慮する） */
  splitStatements(sql: string): string[];
  /** IndexedDB 保存用の素の値へ書き出す */
  exportForIDB(): unknown;
  /** exportForIDB の出力から復元する */
  importFromIDB(dump: unknown): void;
  /** 等価な SQL ダンプを組み立てる */
  exportSQL(): string;
}

/** 列指向のテーブル（TypedArray ストレージ） */
export declare class Table {
  constructor(capacity?: number);
  readonly rowCount: number;
  getValue(col: string, idx: number): string | number | boolean | null;
  getColumnNames(): string[];
}

export declare const LUMINA_VERSION: string;

export declare function createDatabase(options?: {
  statementTimeoutMs?: number;
  readOnly?: boolean;
}): DatabaseEngine;

declare const _default: {
  createDatabase: typeof createDatabase;
  DatabaseEngine: typeof DatabaseEngine;
  Table: typeof Table;
  LUMINA_VERSION: string;
};
export default _default;
