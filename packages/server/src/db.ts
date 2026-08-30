import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Clip, ClipStatus, Source } from "@clipper/shared";

export type SourceRow = {
  id: string;
  path: string;
  name: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string;
  audio_rate: number;
  audio_channels: number;
  mtime: number;
  added_at: number;
  broken: number;
};

export type ClipRow = {
  id: string;
  source_id: string | null;
  start_sec: number;
  end_sec: number;
  status: ClipStatus;
  error: string | null;
  created_at: number;
  file_path: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  video_codec: string;
  audio_codec: string;
  audio_rate: number;
  audio_channels: number;
};

export type SqlStmt = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
};

export type SqlDatabase = {
  prepare: (sql: string) => SqlStmt;
  exec: (sql: string) => void;
  transaction: <Args extends unknown[]>(
    fn: (...args: Args) => void,
  ) => (...args: Args) => void;
};

export function openDb(dataDir: string): SqlDatabase {
  fs.mkdirSync(dataDir, { recursive: true });
  const raw = new DatabaseSync(path.join(dataDir, "clipper.sqlite"));
  raw.exec("PRAGMA journal_mode = WAL");
  const db: SqlDatabase = {
    prepare: (sql) => raw.prepare(sql) as SqlStmt,
    exec: (sql) => {
      raw.exec(sql);
    },
    transaction:
      <Args extends unknown[]>(fn: (...args: Args) => void) =>
      (...args: Args) => {
        raw.exec("BEGIN");
        try {
          fn(...args);
          raw.exec("COMMIT");
        } catch (err) {
          raw.exec("ROLLBACK");
          throw err;
        }
      },
  };
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      duration REAL NOT NULL,
      fps REAL NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      video_codec TEXT NOT NULL,
      audio_codec TEXT NOT NULL,
      audio_rate INTEGER NOT NULL,
      audio_channels INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      broken INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS clips (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      file_path TEXT,
      duration REAL NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      fps REAL NOT NULL,
      video_codec TEXT NOT NULL,
      audio_codec TEXT NOT NULL,
      audio_rate INTEGER NOT NULL,
      audio_channels INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sequence (
      position INTEGER PRIMARY KEY,
      clip_id TEXT NOT NULL
    );
  `);
  return db;
}

export function sourceToDto(row: SourceRow, thumbCount: number): Source {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    duration: row.duration,
    fps: row.fps,
    width: row.width,
    height: row.height,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    audioRate: row.audio_rate,
    audioChannels: row.audio_channels,
    mtime: row.mtime,
    addedAt: row.added_at,
    broken: row.broken === 1,
    thumbCount,
  };
}

export function clipToDto(
  row: ClipRow,
  thumbCount: number,
  sourceName: string | null,
): Clip {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceName,
    startSec: row.start_sec,
    endSec: row.end_sec,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    audioRate: row.audio_rate,
    audioChannels: row.audio_channels,
    thumbCount,
  };
}
