import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FILMSTRIP_FRAME_HEIGHT,
  FILMSTRIP_FRAME_WIDTH,
  LIST_THUMB_MAX,
  filmstripFineCount,
  filmstripFrameFile,
  filmstripFrameTime,
  isHtml5Safe,
  type Clip,
  type Filmstrip,
  type PlaybackStatus,
  type Source,
} from "@clipper/shared";
import {
  clipToDto,
  openDb,
  sourceToDto,
  type ClipRow,
  type SourceRow,
  type SqlDatabase,
} from "./db.js";
import { EventBus } from "./events.js";
import {
  concatCopy,
  concatEncode,
  cutCopy,
  cutEncode,
  encodePreview,
  extractFilmstrip,
  extractThumbs,
  keyframesNear,
  mediaFileReady,
  onKeyframe,
  probeFile,
  writeConcatList,
} from "./ffmpeg.js";
import { countThumbs, resetStripDir, stripMetaCurrent, writeStripMeta } from "./media.js";
import { JobQueue } from "./queue.js";

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
const UUID_RE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLIP_FILE_RE = new RegExp(`^(${UUID_RE})\\.mp4(?:\\.part\\.mp4)?$`, "i");
const KIND_FILE_RE = new RegExp(
  `^(source|clip)-(${UUID_RE})(?:-\\d+)?(?:\\.mp4)?(?:\\.part\\.mp4)?$`,
  "i",
);
const THUMB_RE = new RegExp(`^(source|clip)-(${UUID_RE})-\\d+(?:\\.part)?\\.jpg$`, "i");
const STRIP_DIR_RE = new RegExp(`^(source|clip)-(${UUID_RE})$`, "i");

export class ClipperApp {
  readonly db: SqlDatabase;
  readonly events = new EventBus();
  readonly queue = new JobQueue(2);
  readonly dataDir: string;
  readonly thumbsDir: string;
  readonly clipsDir: string;
  readonly stripsDir: string;
  readonly previewsDir: string;
  private filmstripJobs = new Set<string>();
  private listThumbJobs = new Set<string>();
  private previewJobs = new Set<string>();
  private previewErrors = new Map<string, string>();

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    this.thumbsDir = path.join(this.dataDir, "thumbs");
    this.clipsDir = path.join(this.dataDir, "clips");
    this.stripsDir = path.join(this.dataDir, "filmstrips");
    this.previewsDir = path.join(this.dataDir, "previews");
    fs.mkdirSync(this.thumbsDir, { recursive: true });
    fs.mkdirSync(this.clipsDir, { recursive: true });
    fs.mkdirSync(this.stripsDir, { recursive: true });
    fs.mkdirSync(this.previewsDir, { recursive: true });
    this.db = openDb(this.dataDir);
    this.refreshBrokenFlags();
    this.migrateRelativeClipPaths();
    this.recoverWorkspace();
  }

  private refreshBrokenFlags(): void {
    const rows = this.db.prepare("SELECT * FROM sources").all() as SourceRow[];
    const upd = this.db.prepare("UPDATE sources SET broken = ? WHERE id = ?");
    for (const row of rows) {
      const broken = fs.existsSync(row.path) ? 0 : 1;
      if (broken !== row.broken) upd.run(broken, row.id);
    }
  }

  sourceThumbPath(id: string, n: number): string {
    return path.join(this.thumbsDir, `source-${id}-${n}.jpg`);
  }

  clipThumbPath(id: string, n: number): string {
    return path.join(this.thumbsDir, `clip-${id}-${n}.jpg`);
  }

  clipFilePath(id: string): string {
    return path.join(this.clipsDir, `${id}.mp4`);
  }

  /** Absolute path to a clip file, including rows stored as cwd-relative paths. */
  resolveClipFile(clip: { id: string; file_path: string | null }): string | null {
    const candidates = [
      clip.file_path && path.isAbsolute(clip.file_path) ? clip.file_path : null,
      clip.file_path ? path.resolve(clip.file_path) : null,
      this.clipFilePath(clip.id),
    ];
    for (const file of candidates) {
      if (file && fs.existsSync(file)) return file;
    }
    return null;
  }

  private migrateRelativeClipPaths(): void {
    const rows = this.db
      .prepare("SELECT id, file_path FROM clips WHERE file_path IS NOT NULL")
      .all() as { id: string; file_path: string }[];
    const upd = this.db.prepare("UPDATE clips SET file_path = ? WHERE id = ?");
    for (const row of rows) {
      const resolved = this.resolveClipFile(row);
      if (resolved && resolved !== row.file_path) upd.run(resolved, row.id);
    }
  }

  /** Replay unfinished work left behind if the previous process died mid-job. */
  private recoverWorkspace(): void {
    this.removeStaleTempFiles();
    this.pruneOrphanMedia();
    this.pruneDanglingSequence();
    this.resumeInterruptedClips();
    this.resumeBackgroundJobs();
  }

  private readNames(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }

  private isTempName(name: string): boolean {
    return name.includes(".part.") || name.endsWith(".part");
  }

  private removeStaleTempFiles(): void {
    for (const name of this.readNames(this.thumbsDir)) {
      if (this.isTempName(name)) fs.rmSync(path.join(this.thumbsDir, name), { force: true });
    }
    for (const name of this.readNames(this.dataDir)) {
      if (name.startsWith("concat-") && name.endsWith(".txt")) {
        fs.rmSync(path.join(this.dataDir, name), { force: true });
      }
    }
  }

  private knownIds(): { sources: Set<string>; clips: Set<string> } {
    const sources = new Set(
      (this.db.prepare("SELECT id FROM sources").all() as { id: string }[]).map((r) => r.id),
    );
    const clips = new Set(
      (this.db.prepare("SELECT id FROM clips").all() as { id: string }[]).map((r) => r.id),
    );
    return { sources, clips };
  }

  private knownKind(kind: string, id: string, known: { sources: Set<string>; clips: Set<string> }): boolean {
    if (kind === "source") return known.sources.has(id);
    if (kind === "clip") return known.clips.has(id);
    return false;
  }

  private pruneOrphanMedia(): void {
    const known = this.knownIds();
    for (const name of this.readNames(this.clipsDir)) {
      const clip = CLIP_FILE_RE.exec(name);
      if (!clip?.[1] || known.clips.has(clip[1])) continue;
      fs.rmSync(path.join(this.clipsDir, name), { force: true });
    }
    for (const name of this.readNames(this.previewsDir)) {
      const preview = KIND_FILE_RE.exec(name);
      if (!preview || this.knownKind(preview[1] ?? "", preview[2] ?? "", known)) continue;
      fs.rmSync(path.join(this.previewsDir, name), { force: true });
    }
    for (const name of this.readNames(this.thumbsDir)) {
      const thumb = THUMB_RE.exec(name);
      if (!thumb || this.knownKind(thumb[1] ?? "", thumb[2] ?? "", known)) continue;
      fs.rmSync(path.join(this.thumbsDir, name), { force: true });
    }
    for (const name of this.readNames(this.stripsDir)) {
      const strip = STRIP_DIR_RE.exec(name);
      if (!strip || this.knownKind(strip[1] ?? "", strip[2] ?? "", known)) continue;
      fs.rmSync(path.join(this.stripsDir, name), { recursive: true, force: true });
    }
  }

  private pruneDanglingSequence(): void {
    const ids = this.listSequenceIds();
    const keep = ids.filter((id) => this.getClip(id));
    if (keep.length !== ids.length) this.setSequence(keep);
  }

  private clipLooksPresent(clip: ClipRow): boolean {
    const file = this.resolveClipFile(clip);
    if (!file) return false;
    try {
      return fs.statSync(file).size > 32;
    } catch {
      return false;
    }
  }

  private resumeInterruptedClips(): void {
    const rows = this.db.prepare("SELECT * FROM clips").all() as ClipRow[];
    for (const clip of rows) {
      if (clip.status === "pending") {
        this.resumeCut(clip.id);
        continue;
      }
      if (clip.status !== "ready") continue;
      if (this.clipLooksPresent(clip)) continue;
      const source = clip.source_id ? this.getSource(clip.source_id) : undefined;
      if (!source || !fs.existsSync(source.path)) {
        this.failClip(clip.id, "clip file missing");
        continue;
      }
      this.db
        .prepare("UPDATE clips SET status = 'pending', error = NULL, file_path = NULL WHERE id = ?")
        .run(clip.id);
      const next = this.getClip(clip.id);
      if (next) this.events.emitEvent({ type: "clip", clip: this.clipDto(next) });
      this.resumeCut(clip.id);
    }
  }

  private resumeCut(id: string): void {
    const clip = this.getClip(id);
    if (!clip) return;
    const source = clip.source_id ? this.getSource(clip.source_id) : undefined;
    if (!source || !fs.existsSync(source.path)) {
      this.failClip(id, "source file missing");
      return;
    }
    this.events.emitEvent({ type: "job", kind: "cut", clipId: id, status: "pending" });
    void this.queue.enqueue(() => this.runCut(id));
  }

  private resumeBackgroundJobs(): void {
    const sources = this.db.prepare("SELECT id FROM sources").all() as { id: string }[];
    for (const row of sources) {
      this.ensureListThumbs("source", row.id);
      this.ensurePreview("source", row.id);
    }
    const clips = this.db
      .prepare("SELECT id FROM clips WHERE status = 'ready'")
      .all() as { id: string }[];
    for (const row of clips) {
      this.ensureListThumbs("clip", row.id);
      this.ensurePreview("clip", row.id);
    }
  }

  sourceStripDir(id: string): string {
    return path.join(this.stripsDir, `source-${id}`);
  }

  clipStripDir(id: string): string {
    return path.join(this.stripsDir, `clip-${id}`);
  }

  previewPath(kind: "source" | "clip", id: string): string {
    return path.join(this.previewsDir, `${kind}-${id}.mp4`);
  }

  private originalMedia(
    kind: "source" | "clip",
    id: string,
  ): { path: string; videoCodec: string; audioCodec: string } | null {
    if (kind === "source") {
      const source = this.getSource(id);
      if (!source || !fs.existsSync(source.path)) return null;
      return {
        path: source.path,
        videoCodec: source.video_codec,
        audioCodec: source.audio_codec,
      };
    }
    const clip = this.getClip(id);
    if (!clip || clip.status !== "ready") return null;
    const file = this.resolveClipFile(clip);
    if (!file) return null;
    return {
      path: file,
      videoCodec: clip.video_codec,
      audioCodec: clip.audio_codec,
    };
  }

  private previewReady(kind: "source" | "clip", id: string): boolean {
    const file = this.previewPath(kind, id);
    try {
      return fs.existsSync(file) && fs.statSync(file).size > 32;
    } catch {
      return false;
    }
  }

  ensurePreview(kind: "source" | "clip", id: string): void {
    const orig = this.originalMedia(kind, id);
    if (!orig) return;
    if (isHtml5Safe(orig.path, orig.videoCodec, orig.audioCodec)) return;
    if (this.previewReady(kind, id)) return;
    const key = `${kind}:${id}`;
    if (this.previewJobs.has(key)) return;
    this.previewJobs.add(key);
    this.previewErrors.delete(key);
    this.events.emitEvent({
      type: "job",
      kind: "preview",
      sourceId: kind === "source" ? id : undefined,
      clipId: kind === "clip" ? id : undefined,
      status: "running",
      message: "encoding preview",
    });
    void this.queue.enqueue(async () => {
      let failed = false;
      try {
        const current = this.originalMedia(kind, id);
        if (!current) return;
        if (isHtml5Safe(current.path, current.videoCodec, current.audioCodec)) return;
        if (this.previewReady(kind, id)) return;
        await encodePreview(current.path, this.previewPath(kind, id), Boolean(current.audioCodec));
      } catch (err) {
        failed = true;
        const message = err instanceof Error ? err.message : String(err);
        this.previewErrors.set(key, message);
        fs.rmSync(this.previewPath(kind, id), { force: true });
        fs.rmSync(`${this.previewPath(kind, id)}.part.mp4`, { force: true });
        this.events.emitEvent({
          type: "job",
          kind: "preview",
          sourceId: kind === "source" ? id : undefined,
          clipId: kind === "clip" ? id : undefined,
          status: "failed",
          message,
        });
      } finally {
        this.previewJobs.delete(key);
        if (!failed) {
          this.events.emitEvent({
            type: "job",
            kind: "preview",
            sourceId: kind === "source" ? id : undefined,
            clipId: kind === "clip" ? id : undefined,
            status: "ready",
            message: "preview ready",
          });
        }
      }
    });
  }

  playbackStatus(kind: "source" | "clip", id: string): PlaybackStatus | null {
    const orig = this.originalMedia(kind, id);
    if (!orig) return null;
    if (isHtml5Safe(orig.path, orig.videoCodec, orig.audioCodec)) {
      return { ready: true, encoding: false, proxy: false, error: null };
    }
    const key = `${kind}:${id}`;
    const error = this.previewErrors.get(key) ?? null;
    if (this.previewReady(kind, id)) {
      return { ready: true, encoding: false, proxy: true, error: null };
    }
    this.ensurePreview(kind, id);
    return {
      ready: false,
      encoding: this.previewJobs.has(key) || !error,
      proxy: true,
      error,
    };
  }

  mediaFile(kind: "source" | "clip", id: string, proxy: boolean): string | "missing" | "encoding" {
    const orig = this.originalMedia(kind, id);
    if (!orig) return "missing";
    const safe = isHtml5Safe(orig.path, orig.videoCodec, orig.audioCodec);
    if (safe && !proxy) return orig.path;
    if (this.previewReady(kind, id)) return this.previewPath(kind, id);
    if (safe) return orig.path;
    this.ensurePreview(kind, id);
    return "encoding";
  }

  getSource(id: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
      | SourceRow
      | undefined;
  }

  getClip(id: string): ClipRow | undefined {
    return this.db.prepare("SELECT * FROM clips WHERE id = ?").get(id) as
      | ClipRow
      | undefined;
  }

  sourceDto(row: SourceRow): Source {
    const broken = fs.existsSync(row.path) ? 0 : 1;
    if (broken !== row.broken) {
      this.db.prepare("UPDATE sources SET broken = ? WHERE id = ?").run(broken, row.id);
      row = { ...row, broken };
    }
    return sourceToDto(row, countThumbs(this.thumbsDir, `source-${row.id}`, LIST_THUMB_MAX));
  }

  clipDto(row: ClipRow): Clip {
    const source = row.source_id ? this.getSource(row.source_id) : undefined;
    return clipToDto(
      row,
      countThumbs(this.thumbsDir, `clip-${row.id}`, LIST_THUMB_MAX),
      source?.name ?? null,
    );
  }

  listSources(sort: "date" | "name"): Source[] {
    const order = sort === "name" ? "name COLLATE NOCASE ASC" : "added_at DESC";
    const rows = this.db.prepare(`SELECT * FROM sources ORDER BY ${order}`).all() as SourceRow[];
    const dtos = rows.map((r) => this.sourceDto(r));
    for (const dto of dtos) this.ensureListThumbs("source", dto.id);
    return dtos;
  }

  listClips(): Clip[] {
    const rows = this.db
      .prepare("SELECT * FROM clips ORDER BY created_at DESC")
      .all() as ClipRow[];
    const dtos = rows.map((r) => this.clipDto(r));
    for (const dto of dtos) this.ensureListThumbs("clip", dto.id);
    return dtos;
  }

  listSequenceIds(): string[] {
    const rows = this.db
      .prepare("SELECT clip_id FROM sequence ORDER BY position ASC")
      .all() as { clip_id: string }[];
    return rows.map((r) => r.clip_id);
  }

  async addSource(filePath: string): Promise<Source> {
    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      throw Object.assign(new Error("unsupported video type"), { statusCode: 400 });
    }
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error("file not found"), { statusCode: 400 });
    }
    const id = randomUUID();
    const stat = fs.statSync(filePath);
    const probe = await this.queue.enqueue(() => probeFile(filePath));
    this.db
      .prepare(
        `INSERT INTO sources (
          id, path, name, duration, fps, width, height, video_codec, audio_codec,
          audio_rate, audio_channels, mtime, added_at, broken
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      )
      .run(
        id,
        filePath,
        path.basename(filePath),
        probe.duration,
        probe.fps,
        probe.width,
        probe.height,
        probe.videoCodec,
        probe.audioCodec,
        probe.audioRate,
        probe.audioChannels,
        Math.floor(stat.mtimeMs),
        Date.now(),
      );
    const row = this.getSource(id);
    if (!row) throw new Error("insert failed");
    const dto = this.sourceDto(row);
    this.events.emitEvent({ type: "source", source: dto });
    this.ensureListThumbs("source", id);
    this.ensurePreview("source", id);
    return dto;
  }

  private thumbPartPath(file: string): string {
    return file.endsWith(".jpg") ? `${file.slice(0, -4)}.part.jpg` : `${file}.part`;
  }

  private async extractThumbsStaged(
    input: string,
    duration: number,
    outputs: string[],
    onFrame?: (index: number, total: number) => void,
  ): Promise<void> {
    const parts = outputs.map((p) => this.thumbPartPath(p));
    try {
      await extractThumbs(input, duration, parts, onFrame);
      if (parts.some((p) => !fs.existsSync(p))) {
        throw new Error("incomplete thumb extract");
      }
      for (let i = 0; i < outputs.length; i++) {
        const part = parts[i];
        const dest = outputs[i];
        if (!part || !dest) continue;
        fs.renameSync(part, dest);
      }
    } finally {
      for (const part of parts) fs.rmSync(part, { force: true });
    }
  }

  private removeListThumbs(kind: "source" | "clip", id: string): void {
    for (let i = 0; i < LIST_THUMB_MAX; i++) {
      const file = kind === "source" ? this.sourceThumbPath(id, i) : this.clipThumbPath(id, i);
      fs.rmSync(file, { force: true });
      fs.rmSync(this.thumbPartPath(file), { force: true });
      fs.rmSync(`${file}.part`, { force: true });
    }
  }

  ensureListThumbs(kind: "source" | "clip", id: string): void {
    const key = `${kind}:${id}`;
    if (this.listThumbJobs.has(key)) return;
    if (kind === "source") {
      const source = this.getSource(id);
      if (!source || source.broken === 1 || !fs.existsSync(source.path)) return;
    } else {
      const clip = this.getClip(id);
      if (!clip || clip.status !== "ready" || !this.resolveClipFile(clip)) return;
    }
    const prefix = kind === "source" ? `source-${id}` : `clip-${id}`;
    if (countThumbs(this.thumbsDir, prefix, LIST_THUMB_MAX) >= LIST_THUMB_MAX) return;
    this.listThumbJobs.add(key);
    this.emitThumbsJob(kind, id, "running", 0, "extracting frames…");
    void this.queue.enqueue(async () => {
      try {
        const still = kind === "source" ? `source-${id}` : `clip-${id}`;
        if (countThumbs(this.thumbsDir, still, LIST_THUMB_MAX) >= LIST_THUMB_MAX) return;
        await this.rebuildListThumbs(kind, id);
      } finally {
        this.listThumbJobs.delete(key);
        this.emitThumbsJob(kind, id, "ready", 1, "frames ready");
      }
    });
  }

  private emitThumbsJob(
    kind: "source" | "clip",
    id: string,
    status: "running" | "ready",
    progress: number,
    message: string,
  ): void {
    this.events.emitEvent({
      type: "job",
      kind: "thumbs",
      sourceId: kind === "source" ? id : undefined,
      clipId: kind === "clip" ? id : undefined,
      status,
      progress,
      message,
    });
  }

  private async rebuildListThumbs(kind: "source" | "clip", id: string): Promise<void> {
    const onFrame = (index: number, total: number) => {
      this.emitThumbsJob(
        kind,
        id,
        "running",
        (index + 1) / total,
        `extracting frames ${index + 1}/${total}`,
      );
    };
    if (kind === "source") {
      const row = this.getSource(id);
      if (row) await this.buildSourceThumbs(row, onFrame);
      return;
    }
    const clip = this.getClip(id);
    if (!clip) return;
    const file = this.resolveClipFile(clip);
    if (!file || clip.status !== "ready") return;
    const outputs = Array.from({ length: LIST_THUMB_MAX }, (_, i) => this.clipThumbPath(id, i));
    try {
      await this.extractThumbsStaged(file, clip.duration, outputs, onFrame);
      const next = this.getClip(id);
      if (next) this.events.emitEvent({ type: "clip", clip: this.clipDto(next) });
    } catch {
      // thumbs are optional
    }
  }

  private async buildSourceThumbs(
    row: SourceRow,
    onFrame?: (index: number, total: number) => void,
  ): Promise<void> {
    const outputs = Array.from({ length: LIST_THUMB_MAX }, (_, i) =>
      this.sourceThumbPath(row.id, i),
    );
    try {
      await this.extractThumbsStaged(row.path, row.duration, outputs, onFrame);
      const source = this.getSource(row.id);
      if (source) this.events.emitEvent({ type: "source", source: this.sourceDto(source) });
    } catch {
      // thumbs are optional
    }
  }

  deleteSource(id: string): void {
    const row = this.getSource(id);
    if (!row) {
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    }
    this.db.prepare("DELETE FROM sources WHERE id = ?").run(id);
    this.removeListThumbs("source", id);
    fs.rmSync(this.sourceStripDir(id), { recursive: true, force: true });
    fs.rmSync(this.previewPath("source", id), { force: true });
    fs.rmSync(`${this.previewPath("source", id)}.part.mp4`, { force: true });
  }

  async applySegments(sourceId: string, segments: { startSec: number; endSec: number }[]): Promise<Clip[]> {
    const source = this.getSource(sourceId);
    if (!source || source.broken === 1 || !fs.existsSync(source.path)) {
      throw Object.assign(new Error("source missing"), { statusCode: 400 });
    }
    const created: Clip[] = [];
    for (const seg of segments) {
      if (!(seg.endSec > seg.startSec + 0.04)) continue;
      const id = randomUUID();
      const duration = seg.endSec - seg.startSec;
      this.db
        .prepare(
          `INSERT INTO clips (
            id, source_id, start_sec, end_sec, status, error, created_at, file_path,
            duration, width, height, fps, video_codec, audio_codec, audio_rate, audio_channels
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          sourceId,
          seg.startSec,
          seg.endSec,
          "pending",
          null,
          Date.now(),
          null,
          duration,
          source.width,
          source.height,
          source.fps,
          source.video_codec,
          source.audio_codec,
          source.audio_rate,
          source.audio_channels,
        );
      const clip = this.getClip(id);
      if (!clip) continue;
      const dto = this.clipDto(clip);
      created.push(dto);
      this.events.emitEvent({ type: "clip", clip: dto });
      this.resumeCut(id);
    }
    return created;
  }

  async retryClip(id: string): Promise<Clip> {
    const clip = this.getClip(id);
    if (!clip) throw Object.assign(new Error("not found"), { statusCode: 404 });
    if (clip.status !== "failed") {
      throw Object.assign(new Error("only failed clips can be retried"), { statusCode: 400 });
    }
    this.db
      .prepare("UPDATE clips SET status = 'pending', error = NULL WHERE id = ?")
      .run(id);
    const next = this.getClip(id);
    if (!next) throw new Error("missing");
    const dto = this.clipDto(next);
    this.events.emitEvent({ type: "clip", clip: dto });
    this.resumeCut(id);
    return dto;
  }

  private async runCut(id: string): Promise<void> {
    const clip = this.getClip(id);
    if (!clip) return;
    const source = clip.source_id ? this.getSource(clip.source_id) : undefined;
    if (!source || !fs.existsSync(source.path)) {
      this.failClip(id, "source file missing");
      return;
    }
    this.db.prepare("UPDATE clips SET status = 'pending', error = NULL WHERE id = ?").run(id);
    this.events.emitEvent({ type: "job", kind: "cut", clipId: id, status: "running", progress: 0 });
    const out = this.clipFilePath(id);
    const tmp = `${out}.part.mp4`;
    try {
      if (await mediaFileReady(out)) {
        fs.rmSync(tmp, { force: true });
      } else if (await mediaFileReady(tmp)) {
        fs.rmSync(out, { force: true });
        fs.renameSync(tmp, out);
      } else {
        fs.rmSync(out, { force: true });
        fs.rmSync(tmp, { force: true });
        const kStart = await keyframesNear(source.path, clip.start_sec);
        const kEnd = await keyframesNear(source.path, clip.end_sec);
        const copy =
          onKeyframe(clip.start_sec, kStart, source.fps) &&
          onKeyframe(clip.end_sec, kEnd, source.fps);
        if (copy) {
          await cutCopy(source.path, clip.start_sec, clip.end_sec, tmp);
        } else {
          await cutEncode(source.path, clip.start_sec, clip.end_sec, tmp);
        }
        fs.renameSync(tmp, out);
      }
      if (!this.getClip(id)) {
        fs.rmSync(out, { force: true });
        fs.rmSync(tmp, { force: true });
        return;
      }
      const probe = await probeFile(out);
      const thumbs = Array.from({ length: LIST_THUMB_MAX }, (_, i) =>
        this.clipThumbPath(id, i),
      );
      await this.extractThumbsStaged(out, probe.duration, thumbs);
      this.db
        .prepare(
          `UPDATE clips SET status = 'ready', error = NULL, file_path = ?, duration = ?,
           width = ?, height = ?, fps = ?, video_codec = ?, audio_codec = ?,
           audio_rate = ?, audio_channels = ? WHERE id = ?`,
        )
        .run(
          out,
          probe.duration,
          probe.width,
          probe.height,
          probe.fps,
          probe.videoCodec,
          probe.audioCodec,
          probe.audioRate,
          probe.audioChannels,
          id,
        );
      const ready = this.getClip(id);
      if (ready) this.events.emitEvent({ type: "clip", clip: this.clipDto(ready) });
      this.events.emitEvent({ type: "job", kind: "cut", clipId: id, status: "ready", progress: 1 });
      this.ensurePreview("clip", id);
    } catch (err) {
      fs.rmSync(out, { force: true });
      fs.rmSync(tmp, { force: true });
      if (!this.getClip(id)) return;
      this.failClip(id, err instanceof Error ? err.message : String(err));
    }
  }

  private failClip(id: string, message: string): void {
    this.db.prepare("UPDATE clips SET status = 'failed', error = ? WHERE id = ?").run(message, id);
    const clip = this.getClip(id);
    if (clip) this.events.emitEvent({ type: "clip", clip: this.clipDto(clip) });
    this.events.emitEvent({ type: "job", kind: "cut", clipId: id, status: "failed", message });
  }

  private removeClipArtifacts(id: string, clip: ClipRow): void {
    const existing = this.resolveClipFile(clip);
    if (existing) fs.rmSync(existing, { force: true });
    fs.rmSync(this.clipFilePath(id), { force: true });
    this.removeListThumbs("clip", id);
    fs.rmSync(this.clipStripDir(id), { recursive: true, force: true });
    fs.rmSync(this.previewPath("clip", id), { force: true });
    fs.rmSync(`${this.previewPath("clip", id)}.part.mp4`, { force: true });
    fs.rmSync(`${this.clipFilePath(id)}.part.mp4`, { force: true });
  }

  deleteClip(id: string): void {
    const clip = this.getClip(id);
    if (!clip) throw Object.assign(new Error("not found"), { statusCode: 404 });
    this.removeClipArtifacts(id, clip);
    this.db.prepare("DELETE FROM sequence WHERE clip_id = ?").run(id);
    this.db.prepare("DELETE FROM clips WHERE id = ?").run(id);
    this.repackSequence();
    this.events.emitEvent({ type: "sequence", clipIds: this.listSequenceIds() });
  }

  clearClips(): void {
    const rows = this.db.prepare("SELECT * FROM clips").all() as ClipRow[];
    for (const clip of rows) {
      this.removeClipArtifacts(clip.id, clip);
    }
    this.db.prepare("DELETE FROM sequence").run();
    this.db.prepare("DELETE FROM clips").run();
    this.events.emitEvent({ type: "sequence", clipIds: [] });
  }

  clipInSequence(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sequence WHERE clip_id = ?").get(id);
    return Boolean(row);
  }

  setSequence(clipIds: string[]): string[] {
    const ins = this.db.prepare("INSERT INTO sequence (position, clip_id) VALUES (?, ?)");
    const trx = this.db.transaction((ids: string[]) => {
      this.db.prepare("DELETE FROM sequence").run();
      ids.forEach((id, i) => {
        if (!this.getClip(id)) {
          throw Object.assign(new Error(`unknown clip ${id}`), { statusCode: 400 });
        }
        ins.run(i, id);
      });
    });
    trx(clipIds);
    const next = this.listSequenceIds();
    this.events.emitEvent({ type: "sequence", clipIds: next });
    return next;
  }

  appendSequence(clipId: string): string[] {
    if (!this.getClip(clipId)) {
      throw Object.assign(new Error("unknown clip"), { statusCode: 400 });
    }
    const ids = this.listSequenceIds();
    ids.push(clipId);
    return this.setSequence(ids);
  }

  moveSequence(ids: string[], delta: number): string[] {
    const seq = this.listSequenceIds();
    const selected = new Set(ids);
    const ordered = seq.filter((id) => selected.has(id));
    if (ordered.length === 0) return seq;
    const minIndex = seq.findIndex((id) => selected.has(id));
    const others = seq.filter((id) => !selected.has(id));
    const insertAt = Math.max(0, Math.min(others.length, minIndex + delta));
    others.splice(insertAt, 0, ...ordered);
    return this.setSequence(others);
  }

  clearSequence(): string[] {
    return this.setSequence([]);
  }

  private repackSequence(): void {
    const ids = this.listSequenceIds();
    this.db.prepare("DELETE FROM sequence").run();
    const ins = this.db.prepare("INSERT INTO sequence (position, clip_id) VALUES (?, ?)");
    ids.forEach((id, i) => ins.run(i, id));
  }

  filmstripCount(duration: number): number {
    return filmstripFineCount(duration);
  }

  getFilmstrip(kind: "source" | "clip", id: string): Filmstrip {
    const duration =
      kind === "source" ? this.getSource(id)?.duration ?? 0 : this.getClip(id)?.duration ?? 0;
    const count = this.filmstripCount(duration);
    const dir = kind === "source" ? this.sourceStripDir(id) : this.clipStripDir(id);
    const valid = stripMetaCurrent(dir, count);
    const frames = Array.from({ length: count }, (_, index) => ({
      index,
      time: filmstripFrameTime(index, count, duration),
      ready: valid && fs.existsSync(path.join(dir, filmstripFrameFile(index))),
    }));
    const readyCount = valid ? frames.reduce((n, f) => n + (f.ready ? 1 : 0), 0) : 0;
    return { kind, id, duration, count, readyCount, frames };
  }

  ensureFilmstrip(kind: "source" | "clip", id: string): void {
    const key = `${kind}:${id}`;
    if (this.filmstripJobs.has(key)) return;
    const strip = this.getFilmstrip(kind, id);
    if (strip.readyCount >= strip.count) return;
    this.filmstripJobs.add(key);
    void this.queue.enqueue(async () => {
      try {
        await this.buildFilmstrip(kind, id);
      } finally {
        this.filmstripJobs.delete(key);
      }
    });
  }

  private async buildFilmstrip(kind: "source" | "clip", id: string): Promise<void> {
    let input: string | undefined;
    let duration = 0;
    if (kind === "source") {
      const source = this.getSource(id);
      if (!source || !fs.existsSync(source.path)) return;
      input = source.path;
      duration = source.duration;
    } else {
      const clip = this.getClip(id);
      if (!clip) return;
      const clipFile = clip.status === "ready" ? this.resolveClipFile(clip) : null;
      if (clipFile) {
        input = clipFile;
        duration = clip.duration;
      } else if (clip.source_id) {
        const source = this.getSource(clip.source_id);
        if (!source || !fs.existsSync(source.path)) return;
        input = source.path;
        duration = clip.end_sec - clip.start_sec;
      }
    }
    if (!input) return;
    const count = this.filmstripCount(duration);
    const dir = kind === "source" ? this.sourceStripDir(id) : this.clipStripDir(id);
    if (!stripMetaCurrent(dir, count)) resetStripDir(dir);
    else fs.mkdirSync(dir, { recursive: true });
    writeStripMeta(dir, {
      count,
      width: FILMSTRIP_FRAME_WIDTH,
      height: FILMSTRIP_FRAME_HEIGHT,
    });
    if (kind === "clip") {
      const clip = this.getClip(id);
      if (clip && !(clip.status === "ready" && this.resolveClipFile(clip))) {
        await this.buildRangedStrip(input, clip.start_sec, clip.end_sec, count, dir, kind, id);
        return;
      }
    }
    await extractFilmstrip(input, duration, count, dir, (_index, readyCount) => {
      this.events.emitEvent({
        type: "filmstrip",
        kind,
        id,
        readyCount,
        count,
      });
    });
    const ready = this.getFilmstrip(kind, id);
    this.events.emitEvent({
      type: "filmstrip",
      kind,
      id,
      readyCount: ready.readyCount,
      count: ready.count,
    });
  }

  private async buildRangedStrip(
    input: string,
    start: number,
    end: number,
    count: number,
    dir: string,
    kind: "source" | "clip",
    id: string,
  ): Promise<void> {
    const duration = Math.max(end - start, 0.04);
    await extractFilmstrip(
      input,
      duration,
      count,
      dir,
      (_index, readyCount) => {
        this.events.emitEvent({
          type: "filmstrip",
          kind,
          id,
          readyCount,
          count,
        });
      },
      start,
    );
  }

  async exportSequence(outputPath: string): Promise<string> {
    const jobId = randomUUID();
    this.events.emitEvent({ type: "export", jobId, status: "pending" });
    await this.queue.waitIdle();
    const ids = this.listSequenceIds();
    if (ids.length === 0) {
      throw Object.assign(new Error("sequence is empty"), { statusCode: 400 });
    }
    const clips = ids.map((id) => this.getClip(id));
    if (clips.some((c) => !c || c.status === "failed")) {
      throw Object.assign(new Error("sequence has failed clips"), { statusCode: 400 });
    }
    await this.queue.waitIdle();
    const ready = ids.map((id) => this.getClip(id));
    const files = ready.map((c) => (c ? this.resolveClipFile(c) : null));
    if (ready.some((c) => !c || c.status !== "ready") || files.some((f) => !f)) {
      throw Object.assign(new Error("clips are not ready"), { statusCode: 400 });
    }
    this.events.emitEvent({ type: "export", jobId, status: "running", progress: 0 });
    await this.queue.enqueue(async () => {
      const first = ready[0]!;
      const match = ready.every(
        (c) =>
          c &&
          c.video_codec === first.video_codec &&
          c.audio_codec === first.audio_codec &&
          c.width === first.width &&
          c.height === first.height &&
          Math.abs(c.fps - first.fps) < 0.05 &&
          c.audio_rate === first.audio_rate &&
          c.audio_channels === first.audio_channels,
      );
      const listFile = path.join(this.dataDir, `concat-${jobId}.txt`);
      const dest = path.resolve(outputPath);
      writeConcatList(listFile, files.filter((f): f is string => Boolean(f)));
      try {
        if (match) {
          await concatCopy(listFile, dest);
        } else {
          await concatEncode(listFile, dest, first.width, first.height, first.fps);
        }
      } finally {
        fs.rmSync(listFile, { force: true });
      }
    });
    this.events.emitEvent({ type: "export", jobId, status: "ready", progress: 1 });
    return jobId;
  }
}
